import { dirname, join } from "node:path";

const revision = "1fe87874288e8359fa3de04d18cc14f56957b000";
const image = "maghemite-cef-builder:ubuntu22";

async function run(command: string, args: string[], cwd: string) {
  const status = await new Deno.Command(command, {
    args,
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!status.success) throw new Error(`${command} failed (${status.code})`);
}

async function exists(path: string) {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

export async function preparePatchedCef(root: string): Promise<string> {
  const override = Deno.env.get("LAUFEY_DEV_DIR");
  if (override) return override;

  const patch = join(root, "packaging/linux/cef-new-file.patch");
  const digest = [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        await Deno.readFile(patch),
      ),
    ),
  ].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const cache = Deno.env.get("XDG_CACHE_HOME") ??
    join(Deno.env.get("HOME") ?? root, ".cache");
  const directory = join(cache, "maghemite", `laufey-${digest.slice(0, 12)}`);
  const binary = join(directory, "cef/build/Release/laufey");
  const marker = join(directory, ".maghemite-ready");
  if (
    await exists(binary) && await exists(marker) &&
    (await Deno.readTextFile(marker)).trim() === revision
  ) return directory;

  await Deno.mkdir(dirname(directory), { recursive: true });
  await Deno.remove(directory, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  await run("git", [
    "clone",
    "--quiet",
    "--depth",
    "1",
    "--branch",
    "v0.7.0",
    "https://github.com/littledivy/laufey.git",
    directory,
  ], root);
  const head = await new Deno.Command("git", {
    args: ["-C", directory, "rev-parse", "HEAD"],
    stdout: "piped",
  }).output();
  if (
    !head.success || new TextDecoder().decode(head.stdout).trim() !== revision
  ) {
    throw new Error("Unexpected Laufey source revision");
  }
  await run("git", ["apply", patch], directory);
  await run("docker", [
    "build",
    "-f",
    join(root, "packaging/linux/Dockerfile.cef"),
    "-t",
    image,
    join(root, "packaging/linux"),
  ], root);
  await run("docker", [
    "run",
    "--rm",
    "--user",
    `${Deno.uid()}:${Deno.gid()}`,
    "-v",
    `${directory}:/src`,
    "-w",
    "/src",
    image,
    "make",
    "cef",
  ], root);
  if (!(await exists(binary))) {
    throw new Error("Patched CEF runtime was not built");
  }
  await Deno.writeTextFile(marker, `${revision}\n`);
  return directory;
}
