import { createSignal } from "solid-js";
import { createAppAPI } from "../../../modules-sdk/js/app.ts";
import type { Json } from "../../../modules-sdk/js/mod.ts";
import {
  FileMoveError,
  type FileSessionChange,
  type FileVersionChange,
  moveSession,
  trashSession,
} from "../../../src/shared/file_moves.ts";
import type { Session } from "./model";

interface FileWorkspace {
  state(): Session;
  request(method: string, p?: Json): Promise<Json>;
  checkpoint(): Promise<void>;
  persist(): Promise<void>;
  apply(change: FileSessionChange): void;
  open(path: string): Promise<void>;
  check(): Promise<void>;
  notify(message: string): void;
}
type Pending = {
  readonly action: "move" | "trash" | "restore";
  readonly from: string;
  readonly to: string;
  readonly updateLinks: boolean;
  readonly paths: string[];
  readonly versions: FileVersionChange[];
};

export function createWorkspaceFiles(w: FileWorkspace) {
  const api = createAppAPI(w.request);
  const [requested, setRequested] = createSignal(false);
  const [preparing, setPreparing] = createSignal(false);
  const [revision, setRevision] = createSignal(0);
  let pending: Pending | undefined;
  let listing: Promise<void> = Promise.resolve();
  const busy = () => requested() || preparing();
  const refresh = () => setRevision((value) => value + 1);
  async function list(path: string, offset: number, signal: AbortSignal) {
    const work = listing.then(() => {
      signal.throwIfAborted();
      return api.files.list({ path, offset });
    });
    // Only the scheduling tail is fulfilled; the caller still receives the original failure.
    listing = work.then(() => undefined, () => undefined);
    return await work;
  }
  async function internal(method: string, p: Record<string, Json>): Promise<Json> {
    if (method === "files.finish") {
      pending = undefined;
      setPreparing(false);
      return null;
    }
    if (method === "files.prepare") {
      if (
        pending || !["move", "trash", "restore"].includes(String(p.action)) ||
        typeof p.from !== "string" || typeof p.to !== "string" ||
        typeof p.updateLinks !== "boolean"
      ) throw new FileMoveError("Invalid or overlapping file operation.");
      if (p.action !== "move" && p.action !== "trash" && p.action !== "restore") {
        throw new FileMoveError("Unknown file operation.");
      }
      setPreparing(true);
      pending = {
        action: p.action,
        from: p.from,
        to: p.to,
        updateLinks: p.updateLinks,
        paths: [],
        versions: [],
      };
      if (pending.action === "move") {
        moveSession(w.state(), { from: pending.from, to: pending.to }, []);
      }
      await w.checkpoint();
      return null;
    }
    if (!pending) throw new FileMoveError("File operation expired.");
    if (method === "files.paths") {
      if (
        !Array.isArray(p.paths) || p.paths.length > 16 ||
        !p.paths.every((path): path is string => typeof path === "string") ||
        pending.paths.length + p.paths.length > 10000
      ) throw new FileMoveError("Invalid file catalog.");
      pending.paths.push(...p.paths);
      return null;
    }
    if (method === "files.versions") {
      if (!Array.isArray(p.changes) || p.changes.length > 16) {
        throw new FileMoveError("Invalid file versions.");
      }
      for (const change of p.changes) {
        if (
          !change || typeof change !== "object" || Array.isArray(change) ||
          typeof change.path !== "string" ||
          typeof change.previousVersion !== "string" ||
          typeof change.version !== "string"
        ) throw new FileMoveError("Invalid file version.");
        pending.versions.push({
          path: change.path, previousVersion: change.previousVersion, version: change.version,
        });
      }
      return null;
    }
    if (method === "files.commit") {
      if (pending.action === "move") {
        w.apply(moveSession(
          w.state(),
          { from: pending.from, to: pending.to },
          pending.updateLinks ? pending.paths : [],
          pending.versions,
        ));
        w.notify(`Moved ${pending.from} to ${pending.to}.`);
      } else if (pending.action === "trash") {
        if (!p.result || typeof p.result !== "object" || Array.isArray(p.result) ||
          typeof p.result.id !== "string") throw new FileMoveError("Invalid trash receipt.");
        const change = trashSession(w.state(), pending.from, p.result.id,
          pending.paths, pending.versions);
        w.apply(change);
        w.notify(`Moved ${pending.from} to trash.${
          change.recovered.length ? ` Kept ${change.recovered.length} unsaved recovery drafts.` : ""
        }`);
      } else w.notify("Restored item from trash.");
      if (Array.isArray(p.warnings) && p.warnings.length) {
        w.notify(`File operation completed; ${p.warningCount} link updates need attention: ${
          p.warnings.filter((warning) => typeof warning === "string").join("; ")
        }`);
      }
      refresh();
      await w.persist();
      return null;
    }
    throw new FileMoveError("Unknown workbench file operation.");
  }
  async function move(path: string, to: string, updateLinks: boolean) {
    if (busy()) throw new FileMoveError("File operation in progress.");
    setRequested(true);
    try {
      const stat = await api.files.stat({ path });
      const doc = w.state().documents.find((item) => item.path === path);
      const parameters = { path, to, version: doc?.diskVersion ?? stat.version, updateLinks };
      await api.request("files.move", parameters);
    } finally {
      setRequested(false);
      await w.check();
    }
  }
  async function trash(path: string) {
    if (busy()) throw new FileMoveError("File operation in progress.");
    setRequested(true);
    try {
      const stat = await api.files.stat({ path });
      const doc = w.state().documents.find((item) => item.path === path);
      await api.request("files.trash", { path, version: doc?.diskVersion ?? stat.version });
    } finally {
      setRequested(false);
      await w.check();
    }
  }
  async function restore(id: string, to?: string) {
    if (busy()) throw new FileMoveError("File operation in progress.");
    setRequested(true);
    try {
      const result = await api.request("files.restoreTrash", { id, ...(to ? { to } : {}) });
      if (result.kind === "file") await w.open(result.path);
    } finally {
      setRequested(false);
      await w.check();
    }
  }
  return {
    busy, revision, refresh, internal, move, trash, restore, list,
    trashList: (offset = 0) => api.request("files.trashList", { offset }),
    reset() {
      pending = undefined;
      setRequested(false);
      setPreparing(false);
    },
  };
}
