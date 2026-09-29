import { createAppAPI, validateAppRequest } from "../../modules-sdk/js/app.ts";
import type { ApplicationCaller } from "../modules/host/application.ts";
import type { NativeApplicationServices } from "../core/services/application.ts";
import { decodeBase64, encodeBase64 } from "jsr:@std/encoding@1/base64";
import {
  FileMoveError,
  type FileMove,
  type FileVersionChange,
  movedPath,
  containsPath,
  rewriteDeletedLinks,
  rewriteMovedLinks,
} from "../shared/file_moves.ts";

type NoteChange = {
  readonly path: string;
  readonly text: string;
  readonly version: string;
};
export type NoteMovePlan = {
  readonly paths: readonly string[];
  readonly notes: readonly NoteChange[];
};
const excluded = new Set([
  ".git", ".hg", ".svn", "node_modules", "target", ".venv",
  "__pycache__", ".maghemite-trash",
]);
function fileAPI(native: NativeApplicationServices, caller: ApplicationCaller) {
  return createAppAPI((method, p) => {
    validateAppRequest(method, p);
    if (method === "app.describe") {
      return Promise.resolve({ version: 1, methods: native.methods() });
    }
    return native.request(method, p, caller);
  });
}

/** Read a bounded, current disk catalog; the index may still be catching up. */
export async function planNoteMove(
  native: NativeApplicationServices,
  move: FileMove,
  caller: ApplicationCaller,
): Promise<NoteMovePlan> {
  return planNoteChange(native, move, undefined, caller);
}

export async function planNoteTrash(
  native: NativeApplicationServices,
  deleted: string,
  caller: ApplicationCaller,
): Promise<NoteMovePlan> {
  return planNoteChange(native, undefined, deleted, caller);
}

async function planNoteChange(
  native: NativeApplicationServices,
  move: FileMove | undefined,
  deleted: string | undefined,
  caller: ApplicationCaller,
): Promise<NoteMovePlan> {
  const api = fileAPI(native, caller);
  const paths: string[] = [], directories = [""];
  let entries = 0;
  while (directories.length) {
    const directory = directories.pop();
    if (directory === undefined) break;
    if (directory.split("/").length > 128) {
      throw new FileMoveError("Folder is too deep for automatic link updates.");
    }
    let offset = 0;
    for (;;) {
      caller.signal.throwIfAborted();
      const page = await api.files.list({ path: directory, offset });
      for (const entry of page.entries) {
        if (++entries > 10000) {
          throw new FileMoveError(
            "Workspace exceeds the automatic link-update limit.",
          );
        }
        const path = directory ? `${directory}/${entry.name}` : entry.name;
        if (entry.kind === "directory" && !excluded.has(entry.name)) directories.push(path);
        else if (entry.kind === "file") paths.push(path);
      }
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
  }
  const notes: NoteChange[] = [];
  let total = 0;
  for (const path of paths.filter((p) => /\.mdx?$/i.test(p))) {
    if (deleted && containsPath(deleted, path)) continue;
    let offset = 0, version: string | undefined;
    let text = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (;;) {
      const page = await api.files.read({ path, offset, ...(version ? { version } : {}) });
      if (page.size > 2 * 1024 * 1024 || total + page.size > 16 * 1024 * 1024) {
        throw new FileMoveError(
          "Notes exceed the automatic link-update limit.",
        );
      }
      version = page.version;
      text += decoder.decode(decodeBase64(page.data), { stream: page.nextOffset !== null });
      if (text.includes("\0")) throw new FileMoveError(`Cannot update binary note: ${path}`);
      if (page.nextOffset === null) {
        total += page.size;
        break;
      }
      offset = page.nextOffset;
    }
    const updated = move
      ? rewriteMovedLinks(text, path, move, paths)
      : deleted ? rewriteDeletedLinks(text, path, deleted, paths) : text;
    if (updated !== text && version) {
      notes.push({ path: move ? movedPath(path, move) : path, text: updated, version });
    }
  }
  return { paths, notes };
}

/** A rename has already committed. Report per-note failures without hiding it. */
export async function applyNoteMove(
  native: NativeApplicationServices,
  plan: NoteMovePlan,
  caller: ApplicationCaller,
): Promise<{ changes: FileVersionChange[]; warnings: string[] }> {
  const api = fileAPI(native, caller);
  const changes: FileVersionChange[] = [], warnings: string[] = [];
  for (const note of plan.notes) {
    let upload: string | undefined;
    try {
      caller.signal.throwIfAborted();
      const stage = await api.files.beginWrite({ path: note.path, version: note.version });
      upload = stage.upload;
      const bytes = new TextEncoder().encode(note.text);
      for (let offset = 0; offset < bytes.length; offset += 16384) {
        await api.files.writeChunk({
          upload, offset, data: encodeBase64(bytes.subarray(offset, offset + 16384)),
        });
      }
      const result = await api.files.commitWrite({ upload });
      upload = undefined;
      changes.push({ path: note.path, previousVersion: note.version, version: result.version });
    } catch (error) {
      warnings.push(`${note.path}: ${String(error)}`);
    } finally {
      if (upload) {
        try {
          await native.request("files.abortWrite", { upload }, {
            ...caller, signal: AbortSignal.timeout(3000),
          });
        } catch (error) {
          warnings.push(`Could not release staged note ${note.path}: ${String(error)}`);
        }
      }
    }
  }
  return { changes, warnings };
}
