import { join } from "node:path";
import { AOT_LIMITS, type ArtifactSource } from "../../shared/module_aot.ts";
import { loadPackage, type ModulePackage } from "./manifest.ts";
import { compareTargets, invariant, slotId } from "./aot-schema.ts";
import {
  contains, inspectFile, integrity, regularPath, removeOwned, syncDirectory,
} from "./aot-files.ts";

export interface PackageSnapshot {
  readonly slot: string;
  readonly package: ModulePackage;
  readonly manifestSha256: string;
  readonly targets: readonly ArtifactSource[];
}

export async function inspectSnapshot(root: string, slot: string): Promise<PackageSnapshot> {
  slotId(slot);
  await regularPath(root, join(root, "maghemite.module.json"));
  const pkg = await loadPackage(root);
  const manifest = await inspectFile(join(root, "maghemite.module.json"), AOT_LIMITS.descriptor);
  const targets: ArtifactSource[] = [];
  if (pkg.manifest.runtime === "wasm") {
    invariant(pkg.manifest.entry !== undefined, "Missing component entry");
    const path = join(root, pkg.manifest.entry);
    await regularPath(root, path);
    const source = await inspectFile(path, AOT_LIMITS.component);
    targets.push({
      kind: "component-entry", toolId: null, format: "component",
      abi: pkg.manifest.wasmProfile === "sync" ? "component-sync-v1" : "component-async-v1",
      sourcePath: pkg.manifest.entry, sourceSize: source.size, sourceSha256: source.sha256,
    });
  }
  for (const tool of pkg.manifest.wasmTools ?? []) {
    const path = join(root, tool.path);
    await regularPath(root, path);
    const source = await inspectFile(path, AOT_LIMITS.tool);
    integrity(source.sha256 === tool.sha256, "Snapshot tool digest changed");
    targets.push({
      kind: "wasi-tool", toolId: tool.id, format: "core-module",
      abi: tool.stdin === "cooperative-v1" ? "wasi-p1-cooperative-v1" : "wasi-p1-blocking-v1",
      sourcePath: tool.path, sourceSize: source.size, sourceSha256: source.sha256,
    });
  }
  return {
    slot, package: pkg, manifestSha256: manifest.sha256,
    targets: Object.freeze(targets.sort(compareTargets).map((t) => Object.freeze(t))),
  };
}

/** Existing manager copy policy, with bounded same-buffer copying and file sync. */
export async function copyReviewedPackage(
  sourceDirectory: string,
  destination: string,
  signal: AbortSignal,
): Promise<void> {
  const rootInfo = await Deno.lstat(sourceDirectory);
  invariant(!rootInfo.isSymlink && rootInfo.isDirectory, "Symlinks are not supported");
  const root = await Deno.realPath(sourceDirectory);
  invariant(!contains(root, destination) && !contains(destination, root), "Package overlaps private storage");
  const source = await loadPackage(root);
  const maximum = (source.manifest.wasmTools?.length ? 192 : 96) * 1024 * 1024;
  let files = 0;
  let bytes = 0;
  const copy = async (from: string, to: string, depth: number): Promise<void> => {
    signal.throwIfAborted();
    invariant(depth <= 32 && ++files <= 4096, "Package file count or nesting limit exceeded");
    const info = await Deno.lstat(from);
    invariant(!info.isSymlink && (info.isDirectory || info.isFile), "Symlinks and special files are not supported");
    invariant(contains(root, await Deno.realPath(from)), "Package path escaped source directory");
    if (info.isDirectory) {
      await Deno.mkdir(to, { mode: 0o700 });
      for await (const entry of Deno.readDir(from)) {
        await copy(join(from, entry.name), join(to, entry.name), depth + 1);
      }
      await syncDirectory(to);
    } else {
      invariant(bytes + info.size <= maximum, "Package size limit exceeded");
      const copied = await inspectFile(from, maximum - bytes, to);
      bytes += copied.size;
      signal.throwIfAborted();
    }
  };
  // A caller cannot use this helper to overwrite an existing reviewed package.
  try {
    await Deno.lstat(destination);
    invariant(false, "Snapshot destination already exists");
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  try {
    await copy(root, destination, 0);
    await loadPackage(destination);
  } catch (error) {
    await removeOwned(destination);
    throw error;
  }
}

export async function validateSnapshot(snapshot: PackageSnapshot): Promise<void> {
  const current = await inspectSnapshot(snapshot.package.root, snapshot.slot);
  integrity(
    current.manifestSha256 === snapshot.manifestSha256 &&
      JSON.stringify(current.targets) === JSON.stringify(snapshot.targets),
    "Reviewed source snapshot changed",
  );
}
