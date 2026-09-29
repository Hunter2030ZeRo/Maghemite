import { dirname, join } from "node:path";

export interface AssetManifest {
  platform: string;
  files: { path: string; hash: string; executable: boolean }[];
  core: string;
  wasm: string;
  deno: string;
  pty: string;
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function readAssetManifest(
  directory: string,
): Promise<AssetManifest> {
  const manifest = JSON.parse(
    await Deno.readTextFile(join(directory, "assets.json")),
  ) as AssetManifest;
  if (manifest.platform !== `${Deno.build.os}-${Deno.build.arch}`) {
    throw new Error("Native payload does not match this platform");
  }
  const paths = new Set<string>();
  for (const item of manifest.files) {
    if (
      !item.path || item.path.split("/").some((p) =>
        !p || p === "." || p === ".."
      ) ||
      item.path.includes("\\") || !/^[a-f0-9]{64}$/.test(item.hash) ||
      paths.has(item.path)
    ) {
      throw new Error("Invalid packaged asset manifest");
    }
    paths.add(item.path);
  }
  for (
    const name of [manifest.core, manifest.wasm, manifest.deno, manifest.pty]
  ) {
    if (!paths.has(name)) throw new Error("Missing native asset in manifest");
  }
  return manifest;
}
/** Installed packages are immutable resources: no extraction, copying or startup hashing. */
export async function installedAssets(executable: string) {
  const directory = join(dirname(await Deno.realPath(executable)), "assets");
  return { directory, manifest: await readAssetManifest(directory) };
}
/** Portable executables must materialize embedded native code before dlopen/exec. */
export async function embeddedAssets(source: string, dataDirectory: string) {
  const manifest = await readAssetManifest(source);
  const manifestText = await Deno.readTextFile(join(source, "assets.json"));
  const directory = join(
    dataDirectory,
    "runtime",
    await sha256(new TextEncoder().encode(manifestText)),
  );
  await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
  for (const item of manifest.files) {
    const destination = join(directory, item.path);
    try {
      if (await sha256(await Deno.readFile(destination)) === item.hash) {
        continue;
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const bytes = await Deno.readFile(join(source, item.path));
    if (await sha256(bytes) !== item.hash) {
      throw new Error(`Damaged embedded asset: ${item.path}`);
    }
    await Deno.mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    try {
      await Deno.writeFile(temporary, bytes, {
        createNew: true,
        mode: item.executable ? 0o700 : 0o600,
      });
      await Deno.rename(temporary, destination);
    } finally {
      await Deno.remove(temporary).catch(() => {});
    }
  }
  return { directory, manifest };
}
