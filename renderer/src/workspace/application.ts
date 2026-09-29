import {
  createWorkbenchServices,
  type WorkbenchServicesAccess,
} from "./services.ts";
import type { DocumentEdit } from "../../../modules-sdk/js/services.ts";
import { prepareProjectDocuments } from "../editors/project_documents.ts";
import {
  type AppMethod,
  type DocumentInfo,
  validateAppRequest,
} from "../../../modules-sdk/js/app.ts";
import type { Json } from "../../../modules-sdk/js/mod.ts";
import {
  headings,
  type Layout,
  links,
  type WorkspaceDocument,
} from "./model.ts";

/** Shared by Monaco and CodeMirror adapters. No DOM access. */
export interface WorkbenchAccess extends WorkbenchServicesAccess {
  documents(): readonly WorkspaceDocument[];
  active():
    | {
      documentId?: string;
      type: "document" | "graph" | "custom" | "settings";
    }
    | undefined;
  mode(): "develop" | "knowledge";
  knowledge?(): {
    nodes: { id: string; path: string }[];
    edges: { source: string; target: string }[];
    truncated: boolean;
  };
  edit(id: string, text: string): void;
  open(id: string): void;
  layout(value: Partial<Layout>): void;
  notify(text: string): void;
  output(text: string): void;
}

export function createWorkbenchApplication(w: WorkbenchAccess) {
  const id = crypto.randomUUID();
  let serial = 0;
  const versions = new Map<string, { content: string; version: string }>();
  const undo: { id: string; before: string; after: string }[][] = [];
  const projectStages = new Map<string, { owner: string; text: string; expires: number }>();
  let projectSignature = "", projectRevision = "";
  let eventSink: (topic: string, data: Json, owner?: string) => void = () => {};
  const emit = (topic: string, data: Json, owner?: string) =>
    eventSink(topic, data, owner);
  const services = createWorkbenchServices(w, info, boundary, emit);
  function info(d: WorkspaceDocument): DocumentInfo {
    let current = versions.get(d.id);
    if (!current || current.content !== d.content) {
      current = { content: d.content, version: `${id}:${++serial}` };
      versions.set(d.id, current);
    }
    return {
      id: d.id,
      path: d.path,
      kind: d.kind,
      language: d.language,
      version: current.version,
      length: d.content.length,
      dirty: d.content !== d.savedContent,
    };
  }
  function doc(key: string) {
    const d = w.documents().find((d) => d.id === key);
    if (!d) throw new Error("Document not found");
    return d;
  }
  function projectContext() {
    const signature = JSON.stringify(w.documents().map((d) => [
      d.id, info(d).version, d.diskVersion ?? null,
    ]));
    if (signature !== projectSignature) {
      projectSignature = signature;
      projectRevision = `${id}:${++serial}`;
    }
    return { revision: projectRevision };
  }
  function internal(method: string, p: Record<string, Json>, owner: string): Json {
    if (!method.startsWith("project.")) return services.internal(method, p, owner);
    for (const [id, s] of projectStages) if (s.expires < Date.now()) projectStages.delete(id);
    if (method === "project.context") return projectContext();
    if (method === "project.begin") {
      if (projectStages.size) throw new Error("A project edit is already staging; retry shortly");
      const transfer = crypto.randomUUID();
      projectStages.set(transfer, { owner, text: "", expires: Date.now() + 30000 });
      return { transfer };
    }
    const transfer = String(p.transfer), stage = projectStages.get(transfer);
    if (method === "project.abort") {
      if (stage?.owner === owner) projectStages.delete(transfer);
      return null;
    }
    if (!stage || stage.owner !== owner) throw new Error("Unknown project transfer");
    if (method === "project.chunk") {
      if (p.offset !== stage.text.length || typeof p.text !== "string" ||
        p.text.length > 4096 || stage.text.length + p.text.length > 2_000_000) {
        throw new Error("Project staging limit is 2 MB with 4096-unit chunks");
      }
      stage.text += p.text;
      stage.expires = Date.now() + 30000;
      return null;
    }
    if (method !== "project.commit") throw new Error("Unknown project operation");
    const transaction = prepareProjectDocuments(
      JSON.parse(stage.text), w.documents(), (id) => info(doc(id)).version,
      projectContext().revision,
    );
    if (transaction.created.length && !w.create) throw new Error("Document creation unavailable");
    const changed = transaction.changes.filter((c) => c.before !== c.after);
    projectStages.delete(transfer);
    (w.batch ?? ((f: () => void) => f()))(() => {
      for (const d of transaction.created) w.create?.(d);
      for (const c of changed) w.edit(c.id, c.after);
      if (transaction.selection) {
        const s = transaction.selection;
        w.open(s.path);
        services.selection(s.path, s.from, s.to);
        w.select?.(s.path, s.from, s.to);
      }
    });
    if (changed.length) {
      undo.push(changed);
      if (undo.length > 20) undo.shift();
    }
    emit("workspace.changed", { reason: "project-edit" });
    return {
      applied: changed.length,
      bindings: transaction.created.map((d) => ({ path: d.path, version: d.diskVersion! })),
    };
  }
  function boundary(text: string, position: number) {
    if (position < 0 || position > text.length) {
      throw new Error("Invalid document range");
    }
    const a = text.charCodeAt(position - 1), b = text.charCodeAt(position);
    if (a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff) {
      throw new Error("Range splits a Unicode character");
    }
  }
  function invoke(
    method: AppMethod,
    parameters: Json,
    moduleId: string,
    owner = moduleId,
  ): Json {
    validateAppRequest(method, parameters);
    const p = parameters as Record<string, Json>;
    const extra = services.invoke(method, p, moduleId, owner);
    if (extra !== undefined) return extra;
    const documents = [...w.documents()];
    switch (method) {
      case "workspace.getInfo":
        return {
          id,
          storage: "browser-preview",
          mode: w.mode(),
          documents: documents.length,
        };
      case "documents.list": {
        const offset = (p.offset as number | undefined) ?? 0;
        return {
          documents: documents.slice(offset, offset + 20).map((d) => ({
            ...info(d),
          })),
          nextOffset: offset + 20 < documents.length ? offset + 20 : null,
        };
      }
      case "documents.read": {
        const d = doc(p.id as string),
          metadata = info(d),
          offset = (p.offset as number | undefined) ?? 0;
        if (p.version !== undefined && p.version !== metadata.version) {
          throw new Error("Document version conflict");
        }
        boundary(d.content, offset);
        let end = Math.min(d.content.length, offset + 4096);
        if (
          end < d.content.length && /[\uD800-\uDBFF]/.test(d.content[end - 1])
        ) end--;
        return {
          document: { ...metadata },
          text: d.content.slice(offset, end),
          offset,
          nextOffset: end < d.content.length ? end : null,
        };
      }
      case "documents.applyEdit":
      case "documents.applyEdits": {
        const edits =
          (method === "documents.applyEdit"
            ? [p]
            : p.edits) as unknown as DocumentEdit[];
        const groups = new Map<string, DocumentEdit[]>();
        for (const e of edits) {
          const list = groups.get(e.id) ?? [];
          list.push(e);
          groups.set(e.id, list);
        }
        const changes = [...groups].map(([id, list]) => {
          const d = doc(id), before = d.content;
          list.sort((a, b) => a.from - b.from || a.to - b.to);
          let last = -1, after = "", cursor = 0;
          for (const e of list) {
            if (info(d).version !== e.version) {
              throw new Error("Document version conflict");
            }
            boundary(before, e.from);
            boundary(before, e.to);
            if (e.from > e.to || e.from < last || e.text.includes("\0")) {
              throw new Error("Overlapping or invalid edits");
            }
            after += before.slice(cursor, e.from) + e.text;
            cursor = e.to;
            last = e.to;
          }
          after += before.slice(cursor);
          if (after.length > 256 * 1024) throw new Error("Document size limit");
          return { id, before, after };
        });
        if (
          documents.reduce(
                (n, d) => n + d.content.length + d.savedContent.length,
                0,
              ) +
              changes.reduce(
                (n, c) => n + c.after.length - c.before.length,
                0,
              ) > 2_000_000
        ) throw new Error("Workspace draft limit reached");
        const changed = changes.filter((c) => c.before !== c.after);
        if (changed.length) {
          undo.push(changed);
          if (undo.length > 20) undo.shift();
          (w.batch ?? ((f: () => void) => f()))(() => {
            for (const c of changed) w.edit(c.id, c.after);
          });
        }
        const result = changes.map((c) => ({ ...info(doc(c.id)) }));
        return method === "documents.applyEdit"
          ? result[0]
          : { documents: result };
      }
      case "editor.getActive":
        return {
          documentId: w.active()?.documentId ?? null,
          view: w.active()?.type ?? null,
        };
      case "editor.open":
        w.open(doc(p.id as string).id);
        return null;
      case "workspace.search": {
        const matches: { id: string; line: number; text: string }[] = [];
        const query = (p.query as string).toLocaleLowerCase();
        for (const d of documents) {
          const lines = d.content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLocaleLowerCase().includes(query)) {
              if (matches.length === 30) return { matches, truncated: true };
              matches.push({
                id: d.id,
                line: i + 1,
                text: lines[i].slice(0, 160),
              });
            }
          }
        }
        return { matches, truncated: false };
      }
      case "knowledge.outline": {
        const d = doc(p.id as string);
        if (d.kind !== "note") {
          throw new Error("Outline currently supports Markdown notes");
        }
        const result = headings(d.content);
        return {
          headings: result.slice(0, 30).map((h) => ({
            ...h,
            text: h.text.slice(0, 160),
          })),
          truncated: result.length > 30,
        };
      }
      case "knowledge.backlinks": {
        const all = [
          ...new Set(
            (w.knowledge?.().edges ?? links(documents)).filter((edge) =>
              edge.target === p.id
            ).map((edge) => edge.source),
          ),
        ];
        const sources = boundedKnowledge(all, 100);
        return {
          sources,
          truncated: sources.length < all.length || !!w.knowledge?.().truncated,
        };
      }
      case "knowledge.graph": {
        const graph = w.knowledge?.();
        const allNodes = graph?.nodes ??
          documents.filter((d) => d.kind === "note");
        const allEdges = graph?.edges ?? links(documents);
        const nodes = boundedKnowledge(
          allNodes.map((d) => ({ id: d.id, path: d.path })),
          100,
        );
        const ids = new Set(nodes.map((node) => node.id));
        const edges = boundedKnowledge(
          allEdges.filter((edge) =>
            ids.has(edge.source) && ids.has(edge.target)
          ).map((edge) => ({ source: edge.source, target: edge.target })),
          100,
        );
        return {
          nodes,
          edges,
          truncated: nodes.length < allNodes.length ||
            edges.length < allEdges.length || !!graph?.truncated,
        };
      }
      case "ui.notify":
        w.notify(`[${moduleId}] ${p.message}`);
        return null;
      case "output.append":
        w.output(`[${moduleId}] ${p.text}`);
        return null;
      case "ui.setPanel":
        w.layout({ [p.panel as string]: p.visible as boolean });
        return null;
      default:
        throw new Error("Service unavailable in this workbench");
    }
  }
  return {
    invoke,
    documentVersion: (id: string) => info(doc(id)).version,
    selectionFor: services.selectionFor,
    remapDocuments(ids: ReadonlyMap<string, string>, removed: ReadonlySet<string>) {
      projectStages.clear();
      projectSignature = "";
      versions.clear();
      for (let index = undo.length - 1; index >= 0; index--) {
        const entry = undo[index];
        if (entry.some((change) => removed.has(change.id))) undo.splice(index, 1);
        else for (const change of entry) change.id = ids.get(change.id) ?? change.id;
      }
      services.remapDocuments(ids, removed);
      emit("workspace.changed", { reason: "file-operation" });
    },
    /** Release old workspace text held by revision and module-undo bookkeeping. */
    resetDocuments() {
      projectStages.clear();
      projectSignature = "";
      versions.clear();
      undo.length = 0;
    },
    internal,
    release: services.release,
    action: services.action,
    reset: services.reset,
    views: services.views,
    diagnostics: services.diagnostics,
    selection: services.selection,
    onEvent(sink: (topic: string, data: Json, owner?: string) => void) {
      eventSink = sink;
    },
    /** Observe each edit, including user edits that later return to identical text. */
    changed(documentId: string) {
      versions.delete(documentId);
      emit("documents.changed", { id: documentId });
    },
    undo() {
      const entry = undo.at(-1);
      if (!entry) {
        w.notify("No module edit to undo");
        return;
      }
      for (const c of entry) {
        if (doc(c.id).content !== c.after) {
          throw new Error(
            "Document changed after the module edit; undo would overwrite your changes",
          );
        }
      }
      undo.pop();
      (w.batch ?? ((f: () => void) => f()))(() => {
        for (const c of entry) w.edit(c.id, c.before);
      });
      if (entry[0]) w.open(entry[0].id);
      w.notify("Undid module edit");
    },
  };
}

/** Index results can exceed the SDK frame limit even when record counts are bounded. */
function boundedKnowledge<T>(items: T[], count: number): T[] {
  const result: T[] = [];
  let bytes = 0;
  for (const item of items) {
    bytes += new TextEncoder().encode(JSON.stringify(item)).length + 1;
    if (result.length >= count || bytes > 24_000) break;
    result.push(item);
  }
  return result;
}
