import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export type ApplicationPathPlatform = "posix" | "windows";

export function defaultDataDirectory(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ??
    Deno.cwd();
  return Deno.build.os === "windows"
    ? join(
      Deno.env.get("LOCALAPPDATA") ?? join(home, "AppData", "Local"),
      "Maghemite",
    )
    : Deno.build.os === "darwin"
    ? join(home, "Library", "Application Support", "Maghemite")
    : join(
      Deno.env.get("XDG_DATA_HOME") ?? join(home, ".local", "share"),
      "maghemite",
    );
}

export function developmentStorageDirectory(
  dataDirectory = defaultDataDirectory(),
): string {
  return join(dataDirectory, "module-packages", "development");
}

/** Private roots retained by a profile, including its retired Wasmtime cache. */
export function applicationPrivateStorageRoots(
  dataDirectory: string,
): readonly string[] {
  return [
    join(dataDirectory, "module-packages"),
    join(dataDirectory, "wasm-cache"),
  ];
}

/** Old native caches remain private only where an installation retained them. */
export async function retainedNativeCacheRoots(): Promise<string[]> {
  const retained: string[] = [];
  for (
    const root of [
      join(defaultDataDirectory(), "wasm-cache"),
      fileURLToPath(
        new URL("../../modules-sdk/.cache/wasmtime", import.meta.url),
      ),
    ]
  ) {
    try {
      if ((await Deno.stat(root)).isDirectory) retained.push(root);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return retained;
}

export function applicationPathsOverlap(
  left: string,
  right: string,
  platform: ApplicationPathPlatform = Deno.build.os === "windows"
    ? "windows"
    : "posix",
): boolean {
  const path = platform === "windows" ? win32 : posix;
  const normalize = (value: string) => {
    const normalized = path.resolve(value);
    return platform === "windows" ? normalized.toLowerCase() : normalized;
  };
  const a = normalize(left);
  const b = normalize(right);
  const contained = (parent: string, child: string) => {
    const suffix = path.relative(parent, child);
    return suffix === "" ||
      (!path.isAbsolute(suffix) && suffix !== ".." &&
        !suffix.startsWith(`..${path.sep}`));
  };
  return contained(a, b) || contained(b, a);
}

/** Resolve existing aliases while retaining prospective path components. */
export async function canonicalApplicationPath(path: string): Promise<string> {
  let existing = resolve(path);
  const prospective: string[] = [];
  for (;;) {
    try {
      return resolve(
        await Deno.realPath(existing),
        ...prospective.toReversed(),
      );
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      prospective.push(basename(existing));
      existing = parent;
    }
  }
}
