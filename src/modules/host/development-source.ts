import { dirname, join, relative } from "node:path";
import type { ReviewedPackage } from "./aot.ts";
import { AotStore } from "./aot.ts";
import { contains, inspectFile, removeOwned } from "./aot-files.ts";
import { invariant } from "./aot-schema.ts";
import { loadPackage } from "./manifest.ts";

/**
 * Wasm source trees may contain compiler work directories outside the runtime
 * package. Build the package-shaped source first; AotStore then applies the
 * normal reviewed-copy policy to that complete runtime payload.
 */
export async function reviewDevelopmentSource(
  store: AotStore,
  directory: string,
  signal: AbortSignal,
): Promise<ReviewedPackage> {
  const rootInfo = await Deno.lstat(directory);
  invariant(
    !rootInfo.isSymlink && rootInfo.isDirectory,
    "Symlinks are not supported",
  );
  const source = await Deno.realPath(directory);
  invariant(
    !contains(source, store.directory) &&
      !contains(store.directory, source),
    "Package overlaps private storage",
  );
  const pkg = await loadPackage(source);
  if (pkg.manifest.runtime !== "wasm") {
    return await store.review(source, signal);
  }
  const maximum = (pkg.manifest.wasmTools?.length ? 192 : 96) *
    1024 * 1024;
  const stage = await Deno.makeTempDir({
    prefix: "maghemite-development-package-",
  });
  let files = 1;
  let bytes = 0;
  const copied = new Set<string>();
  const copy = async (path: string): Promise<void> => {
    signal.throwIfAborted();
    const relativePath = relative(source, path);
    const parts = relativePath.split(/[\\/]/);
    invariant(
      relativePath.length > 0 && !relativePath.startsWith("..") &&
        parts.every((part) => part && part !== "." && part !== ".."),
      "Development package path escaped source",
    );
    if (copied.has(relativePath)) return;
    invariant(
      parts.length <= 32 && ++files <= 4096,
      "Package file count or nesting limit exceeded",
    );
    let cursor = source;
    for (const part of parts) {
      cursor = join(cursor, part);
      const ancestor = await Deno.lstat(cursor);
      invariant(
        !ancestor.isSymlink,
        "Symlinks and special files are not supported",
      );
    }
    const info = await Deno.lstat(path);
    invariant(
      !info.isSymlink && (info.isDirectory || info.isFile),
      "Development packages cannot contain symlinks or special files",
    );
    invariant(
      contains(source, await Deno.realPath(path)),
      "Development package path escaped source",
    );
    const destination = join(stage, relativePath);
    if (info.isDirectory) {
      copied.add(relativePath);
      await Deno.mkdir(destination, { recursive: true, mode: 0o700 });
      for await (const entry of Deno.readDir(path)) {
        await copy(join(path, entry.name));
      }
      return;
    }
    await Deno.mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    invariant(
      bytes + info.size <= maximum,
      "Package size limit exceeded",
    );
    const file = await inspectFile(path, maximum - bytes, destination);
    bytes += file.size;
    invariant(bytes <= maximum, "Package size limit exceeded");
    copied.add(relativePath);
  };
  try {
    await copy(join(source, "maghemite.module.json"));
    invariant(pkg.manifest.entry !== undefined, "Missing component entry");
    await copy(join(source, pkg.manifest.entry));
    for (const theme of pkg.manifest.contributions.themes) {
      await copy(join(source, theme.path));
    }
    for (const tool of pkg.manifest.wasmTools ?? []) {
      await copy(join(source, tool.path));
      if (tool.assets) await copy(join(source, tool.assets));
    }
    return await store.review(stage, signal);
  } finally {
    await removeOwned(stage);
  }
}
