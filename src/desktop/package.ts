import { basename, dirname, join, resolve } from "node:path";
import { filePath } from "../modules/paths.ts";
import { packageLinux } from "../../packaging/linux/package.ts";
import { sha256 } from "./package_assets.ts";
const root = filePath(new URL("../../", import.meta.url));
const option = (name: string) =>
  Deno.args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
if (
  Deno.args.some((arg) =>
    !["output", "pty-library", "formats"].some((name) =>
      arg.startsWith(`--${name}=`)
    )
  )
) {
  throw new Error(
    "Use --output=..., --formats=deb,rpm,arch,appimage,dir and --pty-library=...; build on the target platform",
  );
}
const requestedOutput = option("output");
const inferredFormat = requestedOutput?.match(
  /\.(deb|rpm|AppImage|pkg\.tar\.zst)$/i,
)?.[1].toLowerCase();
const formats = (option("formats") ??
  (inferredFormat === "pkg.tar.zst" ? "arch" : inferredFormat) ??
  (Deno.build.os === "linux" ? "deb,rpm,arch" : "appimage")).split(",");
if (
  new Set(formats).size !== formats.length ||
  formats.some((format) =>
    !["deb", "rpm", "arch", "appimage", "dir"].includes(format)
  )
) {
  throw new Error("Unknown or duplicate package format");
}
if (
  requestedOutput && Deno.build.os === "linux" &&
  (formats.length !== 1 || (formats[0] !== "dir" &&
    inferredFormat !== (formats[0] === "arch" ? "pkg.tar.zst" : formats[0])))
) {
  throw new Error(
    "--output requires one format and its matching extension; use --formats for multiple packages",
  );
}
if (Deno.build.os !== "linux" && option("formats")) {
  throw new Error("--formats is currently Linux-only");
}
const ptyLibrary = option("pty-library");
if (!ptyLibrary || !(await Deno.stat(ptyLibrary)).isFile) {
  throw new Error(
    "Pass --pty-library=/absolute/path/to/deno-pty-ffi-0.42.0-library (prepared by desktop:prepare-pty)",
  );
}
async function run(command: string, args: string[], cwd = root) {
  const result = await new Deno.Command(command, {
    args,
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!result.success) throw new Error(`${command} failed (${result.code})`);
}
await run("cargo", [
  "build",
  "--release",
  "--locked",
  "-p",
  "maghemite-core",
  "-p",
  "maghemite-wasm-host",
], join(root, "native"));
await run(Deno.execPath(), ["task", "build"]);
const output = resolve(
  option("output") ?? join(
    root,
    "build",
    Deno.build.os === "linux"
      ? "Maghemite.AppImage"
      : Deno.build.os === "darwin"
      ? "Maghemite.app"
      : "Maghemite.exe",
  ),
);
const assets = join(root, "build", "desktop-assets");
await Deno.remove(assets, { recursive: true }).catch((error) => {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
});
await Deno.mkdir(assets, { recursive: true });
const core = Deno.build.os === "windows"
  ? "maghemite_core.dll"
  : Deno.build.os === "darwin"
  ? "libmaghemite_core.dylib"
  : "libmaghemite_core.so";
const wasm = `maghemite-wasm-host${Deno.build.os === "windows" ? ".exe" : ""}`,
  deno = `deno${Deno.build.os === "windows" ? ".exe" : ""}`;
const pty = Deno.build.os === "windows"
  ? "pty.dll"
  : Deno.build.os === "darwin"
  ? "libpty.dylib"
  : "libpty.so";
const files: { path: string; hash: string; executable: boolean }[] = [];
async function copy(source: string, path: string, executable = false) {
  const stat = await Deno.stat(source), destination = join(assets, path);
  if (stat.isDirectory) {
    for await (const item of Deno.readDir(source)) {
      await copy(join(source, item.name), `${path}/${item.name}`, executable);
    }
    return;
  }
  await Deno.mkdir(dirname(destination), { recursive: true });
  await Deno.copyFile(source, destination);
  if (Deno.build.os !== "windows") {
    await Deno.chmod(destination, executable ? 0o755 : 0o644);
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", await Deno.readFile(destination)),
  );
  files.push({
    path,
    hash: [...digest].map((b) => b.toString(16).padStart(2, "0")).join(""),
    executable,
  });
}
await copy(join(root, "native/target/release", core), core);
await copy(join(root, "native/target/release", wasm), wasm, true);
await copy(Deno.execPath(), deno, true);
await copy(ptyLibrary, pty);
await copy(join(root, "renderer/dist"), "renderer");
await copy(join(root, "modules-sdk/js"), "modules-sdk/js");
for (
  const path of [
    "src/modules/runtimes/deno/worker.ts",
    "src/modules/runtimes/protocol.ts",
    "src/modules/paths.ts",
  ]
) await copy(join(root, path), path);
files.sort((a, b) => a.path.localeCompare(b.path));
await Deno.writeTextFile(
  join(assets, "assets.json"),
  JSON.stringify({
    platform: `${Deno.build.os}-${Deno.build.arch}`,
    core,
    wasm,
    deno,
    pty,
    files,
  }),
);
const permissions = [
  "--allow-read",
  "--allow-write",
  "--allow-env",
  "--allow-ffi",
  "--allow-run",
  "--allow-net=127.0.0.1",
  "--no-prompt",
];
if (Deno.build.os === "linux" && formats.some((f) => f !== "appimage")) {
  const bundle = join(root, "build", "linux", "Maghemite");
  await run(Deno.execPath(), [
    "desktop",
    "--backend=cef",
    "--exclude-unused-npm",
    ...permissions,
    "--output",
    bundle,
    "src/desktop/installed.ts",
  ]);
  const destination = join(bundle, "assets");
  await Deno.remove(destination, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  await run("cp", ["-a", assets, destination]);
  await packageLinux({
    root,
    bundle,
    formats: formats.filter((f) => f !== "appimage"),
    output: requestedOutput,
  });
}
if (Deno.build.os !== "linux" || formats.includes("appimage")) {
  await run(Deno.execPath(), [
    "desktop",
    "--backend=cef",
    "--exclude-unused-npm",
    "--include=build/desktop-assets",
    ...permissions,
    "--output",
    requestedOutput ?? output,
    "src/desktop/packaged.ts",
  ]);
  const artifact = requestedOutput ?? output;
  if ((await Deno.stat(artifact)).isFile) {
    await Deno.writeTextFile(
      `${artifact}.sha256`,
      `${await sha256(await Deno.readFile(artifact))}  ${basename(artifact)}\n`,
    );
  }
  console.log(`Portable desktop package: ${artifact}`);
}
