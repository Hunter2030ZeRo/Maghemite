import type { ModulePackage } from "../../host/manifest.ts";
import { ModuleProcess } from "../process.ts";
import { filePath } from "../../paths.ts";

export interface DenoRuntimeOptions {
  executable?: string;
  worker?: string;
  sdkDirectory?: string;
}
export function startDenoModule(
  pkg: ModulePackage,
  options: DenoRuntimeOptions = {},
): ModuleProcess {
  if (pkg.manifest.runtime !== "deno" || !pkg.entry) {
    throw new Error("Not an executable Deno package");
  }
  const worker = options.worker ?? import.meta.dirname + "/worker.ts";
  const sdk = new URL("../../../../modules-sdk/js/", import.meta.url);
  const sdkPath = options.sdkDirectory ?? filePath(sdk);
  if ([pkg.root, sdkPath].some((path) => path.includes(","))) {
    throw new Error("Module paths containing commas are unsupported");
  }
  // Only code/package reads are granted. Workspace and application services
  // are brokered through the parent, never inherited from the desktop host.
  return new ModuleProcess(
    new Deno.Command(options.executable ?? Deno.execPath(), {
      args: [
        "run",
        "--no-config",
        "--no-lock",
        "--no-prompt",
        "--cached-only",
        "--no-remote",
        "--v8-flags=--max-old-space-size=128",
        `--allow-read=${pkg.root},${sdkPath}`,
        "--deny-write",
        "--deny-net",
        "--deny-env",
        "--deny-run",
        "--deny-ffi",
        "--deny-sys",
        worker,
        pkg.entry,
      ],
      cwd: pkg.root,
      clearEnv: true,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }),
  );
}
