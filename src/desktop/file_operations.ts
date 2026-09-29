import type { Json } from "../../modules-sdk/js/mod.ts";
import { validateAppRequest } from "../../modules-sdk/js/app.ts";
import type { ApplicationCaller } from "../modules/host/application.ts";
import type { NativeApplicationServices } from "../core/services/application.ts";
import { containsPath, FileMoveError, movedPath } from "../shared/file_moves.ts";
import { applyNoteMove, type NoteMovePlan, planNoteMove, planNoteTrash } from "./file_links.ts";

export type WorkbenchFileMutation = "files.move" | "files.trash" | "files.restoreTrash";
type DiskBinding = { path: string; version: string };
interface FileAccess {
  readonly native: NativeApplicationServices;
  readonly bindings: Map<string, DiskBinding>;
  readonly documentsBusy: () => boolean;
  readonly invalidateLanguages: () => void;
  readonly workbench: (method: string, p: Json, caller: ApplicationCaller) => Promise<Json>;
}

/** Trusted UI orchestration; raw SDK file operations remain filesystem operations. */
export class WorkbenchFiles {
  changing = false;
  constructor(private readonly access: FileAccess) {}

  async request(
    method: WorkbenchFileMutation,
    parameters: Record<string, Json>,
    caller: ApplicationCaller,
  ): Promise<Json> {
    if (this.changing || this.access.documentsBusy()) {
      throw new FileMoveError("Wait for the current document operation to finish.");
    }
    const { updateLinks, ...p } = parameters;
    if (updateLinks !== undefined && typeof updateLinks !== "boolean") {
      throw new FileMoveError("Invalid link-update option.");
    }
    validateAppRequest(method, p);
    const from = typeof p.path === "string" ? p.path : "";
    const to = typeof p.to === "string" ? p.to : "";
    const action = method === "files.move" ? "move" : method === "files.trash" ? "trash" : "restore";
    const links = (action === "move" && updateLinks !== false) || action === "trash";
    const operation = { action, from, to, updateLinks: links };
    let committed = false;
    this.changing = true;
    try {
      await this.access.workbench("files.prepare", operation, caller);
      const plan: NoteMovePlan = action === "trash"
        ? await planNoteTrash(this.access.native, from, caller)
        : links ? await planNoteMove(this.access.native, { from, to }, caller)
        : { paths: [], notes: [] };
      for (let offset = 0; offset < plan.paths.length; offset += 16) {
        await this.access.workbench("files.paths", {
          paths: plan.paths.slice(offset, offset + 16),
        }, caller);
      }
      caller.signal.throwIfAborted();
      const result = await this.access.native.request(method, p, caller);
      committed = true;
      const bindings = [...this.access.bindings];
      for (const [id, binding] of bindings) {
        if (!containsPath(from, binding.path)) continue;
        if (action === "move") {
          this.access.bindings.delete(id);
          const path = movedPath(binding.path, { from, to });
          this.access.bindings.set(path, { ...binding, path });
        } else if (action === "trash") this.access.bindings.delete(id);
      }
      this.access.invalidateLanguages();
      // The filesystem operation is committed; finish UI reconciliation even if its caller disconnected.
      const completion = { ...caller, signal: AbortSignal.timeout(25000) };
      const updated = await applyNoteMove(this.access.native, plan, completion);
      for (const change of updated.changes) {
        const binding = this.access.bindings.get(change.path);
        if (binding?.version === change.previousVersion) binding.version = change.version;
      }
      for (let offset = 0; offset < updated.changes.length; offset += 16) {
        await this.access.workbench("files.versions", {
          changes: updated.changes.slice(offset, offset + 16).map((change) => ({ ...change })),
        }, completion);
      }
      await this.access.workbench("files.commit", {
        result,
        warnings: updated.warnings.slice(0, 8).map((warning) => warning.slice(0, 1024)),
        warningCount: updated.warnings.length,
      }, completion);
      return result;
    } catch (error) {
      if (committed) {
        throw new FileMoveError(
          `The filesystem operation completed, but workbench reconciliation failed. Your drafts remain in recovery. ${String(error)}`,
        );
      }
      throw error;
    } finally {
      try {
        await this.access.workbench("files.finish", {}, {
          ...caller, signal: AbortSignal.timeout(3000),
        });
      } finally {
        this.changing = false;
      }
    }
  }
}
