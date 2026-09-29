import {
  applyLanguageEdits,
  PROJECT_TEXT_LIMIT,
  projectDocument,
  projectRange,
  projectRecord,
  projectWorkspaceEdit,
  sameLanguageVersion,
} from "../../../modules-sdk/js/project.ts";
import {
  documentFromText,
  type WorkspaceDocument,
} from "../workspace/model.ts";

/** Pure preparation shared by every editor view. No document changes before it returns. */
export function prepareProjectDocuments(
  value: unknown,
  documents: readonly WorkspaceDocument[],
  version: (id: string) => string,
  revision: string,
) {
  const p = projectRecord(value);
  if (p.revision !== revision) throw new Error("Project changed; request the operation again");
  const edit = projectWorkspaceEdit(p.edit);
  if (!Array.isArray(p.snapshots) || p.snapshots.length > 100) {
    throw new Error("Invalid project snapshots");
  }
  const snapshots = new Map(p.snapshots.map((value) => {
    const d = projectDocument(value), text = projectRecord(value).text;
    if (typeof text !== "string" || text.includes("\0") || text.length > 256 * 1024) {
      throw new Error("Invalid project snapshot text");
    }
    return [d.path, { ...d, text }];
  }));
  if (snapshots.size !== p.snapshots.length) throw new Error("Duplicate project snapshot");
  const created: WorkspaceDocument[] = [];
  const changes = edit.documents.map((d) => {
    const existing = documents.find((open) => open.path === d.path);
    const snapshot = snapshots.get(d.path);
    if (!snapshot || !sameLanguageVersion(snapshot.version, d.version)) {
      throw new Error("Project snapshot version conflict");
    }
    let before: string;
    switch (d.version.kind) {
      case "document":
        if (!existing || version(existing.id) !== d.version.value) {
          throw new Error(`Document version conflict: ${d.path}`);
        }
        before = existing.content;
        if (before !== snapshot.text) throw new Error("Project snapshot content conflict");
        break;
      case "disk": {
        if (existing) throw new Error(`Document opened during language operation: ${d.path}`);
        if (!/^[a-f0-9]{64}$/.test(d.version.value)) throw new Error("Invalid disk version");
        before = snapshot.text;
        const document = documentFromText(d.path, before);
        document.diskVersion = d.version.value;
        created.push(document);
        break;
      }
    }
    const after = applyLanguageEdits(before, d.edits);
    if (after.length > 256 * 1024) throw new Error("Document size limit is 256 KiB");
    return { id: d.path, before, after };
  });
  if (documents.length + created.length > 100) throw new Error("Document count limit is 100");
  const size = documents.reduce((n, d) => n + d.content.length + d.savedContent.length, 0) +
    created.reduce((n, d) => n + d.content.length + d.savedContent.length, 0) +
    changes.reduce((n, c) => n + c.after.length - c.before.length, 0);
  if (size > PROJECT_TEXT_LIMIT) throw new Error("Workspace draft limit is 2 MB");
  let selection: { path: string; from: number; to: number } | undefined;
  if (p.selection !== undefined) {
    const s = projectRecord(p.selection);
    const target = changes.find((c) => c.id === s.path);
    if (!target) throw new Error("Project selection target missing");
    selection = { path: target.id, ...projectRange(s, target.after) };
  }
  return { changes, created, selection };
}
