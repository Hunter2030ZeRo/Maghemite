import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";
import { AotError } from "../../shared/module_aot.ts";
import { invariant } from "./aot-schema.ts";

export function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Check every app-owned path component; the final open additionally uses O_NOFOLLOW. */
export async function privateDirectory(root: string, path: string): Promise<void> {
  invariant(contains(root, path), "Path escapes private root");
  let cursor = root;
  const rootInfo = await Deno.lstat(root);
  invariant(rootInfo.isDirectory && !rootInfo.isSymlink, "Invalid private directory");
  if (path === root) return;
  const parts = relative(root, path).split(/[\\/]/);
  for (const part of parts) {
    invariant(part.length > 0, "Expected file path");
    cursor = join(cursor, part);
    const info = await Deno.lstat(cursor);
    invariant(!info.isSymlink && info.isDirectory, "Symlinks or non-directories are not supported");
  }
}

export async function regularPath(root: string, path: string): Promise<void> {
  const parent = join(path, "..");
  await privateDirectory(root, parent);
  const info = await Deno.lstat(path);
  invariant(info.isFile && !info.isSymlink, "Symlinks or non-regular files are not supported");
}

export interface FileDigest {
  readonly size: number;
  readonly sha256: string;
}

/** Bounded streaming reads, optionally copying the exact same bytes to a new file. */
export async function inspectFile(
  path: string,
  maximum: number,
  destination?: string,
): Promise<FileDigest> {
  const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await source.stat();
    invariant(before.isFile() && before.size <= maximum, "File size exceeds limit or is not regular");
    const target = destination
      ? await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
      : undefined;
    try {
      const hash = createHash("sha256");
      const buffer = new Uint8Array(256 * 1024);
      let size = 0;
      while (true) {
        const { bytesRead } = await source.read(buffer);
        if (bytesRead === 0) break;
        size += bytesRead;
        invariant(size <= maximum && size <= before.size, "File changed while reading");
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        if (target) {
          let offset = 0;
          while (offset < bytesRead) {
            const result = await target.write(chunk.subarray(offset));
            invariant(result.bytesWritten > 0, "File write made no progress");
            offset += result.bytesWritten;
          }
        }
      }
      const after = await source.stat();
      invariant(
        size === before.size && after.size === before.size &&
          after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs,
        "File changed while reading",
      );
      if (target) {
        await target.sync();
        await target.chmod(0o400);
      }
      return { size, sha256: hash.digest("hex") };
    } finally {
      await target?.close();
    }
  } finally {
    await source.close();
  }
}

export async function readBounded(path: string, maximum: number): Promise<Uint8Array> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    invariant(stat.isFile() && stat.size <= maximum, "File size exceeds limit or is not regular");
    const bytes = new Uint8Array(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes.subarray(offset));
      invariant(result.bytesRead > 0, "Truncated file");
      offset += result.bytesRead;
    }
    invariant((await file.read(new Uint8Array(1))).bytesRead === 0, "File grew while reading");
    return bytes;
  } finally {
    await file.close();
  }
}

export async function syncDirectory(path: string): Promise<void> {
  // Windows does not support opening/syncing a directory through this API.
  if (Deno.build.os === "windows") return;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function writeSynced(path: string, bytes: Uint8Array): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await file.write(bytes.subarray(offset));
      invariant(bytesWritten > 0, "File write made no progress");
      offset += bytesWritten;
    }
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function removeOwned(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

export function integrity(condition: boolean, message: string): void {
  if (!condition) throw new AotError("integrity", message);
}
