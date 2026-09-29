import { createAppAPI } from "../../modules-sdk/js/app.ts";
import type { Json } from "../../modules-sdk/js/mod.ts";
import { readLanguageDocument, sameLanguageVersion } from "../../modules-sdk/js/project.ts";
import type { LanguageProjectAccess } from "./project_languages.ts";

/** All I/O remains behind the existing confined file service and workbench lease. */
export function languageProjectAccess(
  workspaceId: string,
  rpc: (method: string, p: Json, cleanup?: boolean) => Promise<Json>,
  file: (method: string, p: Json) => Promise<Json>,
  signal: AbortSignal,
): LanguageProjectAccess {
  const app = createAppAPI((method, p) =>
    method.startsWith("files.") ? file(method, p) : rpc(method, p)
  );
  return {
    async context() {
      const value = await rpc("project.context", {}) as { revision: string };
      return { id: workspaceId, revision: value.revision };
    },
    async read(path, version) {
      signal.throwIfAborted();
      const snapshot = await readLanguageDocument(app.request, path);
      if (!sameLanguageVersion(snapshot.version, version)) {
        throw new Error(`Language version conflict: ${path}; request the operation again`);
      }
      signal.throwIfAborted();
      return snapshot;
    },
    async commit(revision, edit, snapshots, selection) {
      signal.throwIfAborted();
      const start = await rpc("project.begin", {}) as { transfer: string };
      try {
        const text = JSON.stringify({
          revision, edit,
          snapshots: snapshots.filter((s) => edit.documents.some((d) => d.path === s.path)),
          ...(selection ? { selection } : {}),
        });
        for (let offset = 0; offset < text.length;) {
          let end = Math.min(offset + 4096, text.length);
          if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
          await rpc("project.chunk", { ...start, offset, text: text.slice(offset, end) });
          offset = end;
        }
        // Disk targets remain unopened until the single renderer commit. Check
        // their native versions once more after transferring the staging payload.
        for (const d of snapshots) {
          if (d.version.kind !== "disk") continue;
          const current = await file("files.stat", { path: d.path }) as { version: string | null };
          if (current.version !== d.version.value) {
            throw new Error(`Language version conflict: ${d.path}; file changed on disk`);
          }
        }
        signal.throwIfAborted();
        return await rpc("project.commit", start);
      } finally {
        await rpc("project.abort", start, true);
      }
    },
  };
}
