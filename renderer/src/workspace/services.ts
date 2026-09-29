import type { Json } from "../../../modules-sdk/js/mod.ts";
import type {
  Diagnostic,
  ViewBlock,
} from "../../../modules-sdk/js/services.ts";
import type { DocumentInfo } from "../../../modules-sdk/js/app.ts";
import { documentFromText, type WorkspaceDocument } from "./model.ts";
export type ModuleView = {
  id: string;
  owner: string;
  moduleId: string;
  title: string;
  location: string;
  blocks: ViewBlock[];
};
export type PublishedDiagnostics = {
  id: string;
  owner: string;
  moduleId: string;
  documentId: string;
  version: string;
  items: Diagnostic[];
};
export interface WorkbenchServicesAccess {
  create?(document: WorkspaceDocument): void;
  close?(documentId: string): void;
  saved?(id: string, text: string): void;
  bind?(id: string, diskVersion: string): void;
  batch?(action: () => void): void;
  refresh?(): void;
  select?(id: string, anchor: number, head: number): void;
  language?(extensions: string[], name: string): void;
  view?(view: ModuleView, remove?: boolean): void;
}
export function createWorkbenchServices(
  w: WorkbenchServicesAccess & {
    documents(): readonly WorkspaceDocument[];
    edit(id: string, text: string): void;
    open(id: string): void;
  },
  info: (d: WorkspaceDocument) => DocumentInfo,
  boundary: (text: string, position: number) => void,
  emit: (topic: string, data: Json, owner?: string) => void,
) {
  const selections = new Map<string, { anchor: number; head: number }>(),
    views = new Map<string, ModuleView>(),
    diagnostics = new Map<string, PublishedDiagnostics>(),
    languages = new Map<
      string,
      { owner: string; id: string; name: string; extensions: string[] }
    >();
  const stages = new Map<
    string,
    {
      owner: string;
      path: string;
      text: string;
      snapshot?: string;
      expires: number;
    }
  >();
  const key = (owner: string, id: string) => `${owner}:${id}`;
  const doc = (id: string) => {
    const d = w.documents().find((d) => d.id === id);
    if (!d) throw new Error("Document not found");
    return d;
  };
  const requireVersion = (id: string, version: string) => {
    const d = doc(id);
    if (info(d).version !== version) {
      throw new Error("Document version conflict");
    }
    return d;
  };
  function capacity(text: string, replacing?: string) {
    if (text.includes("\0") || text.length > 256 * 1024) {
      throw new Error("Document size or encoding limit");
    }
    const all = w.documents();
    if (!replacing && all.length >= 100) {
      throw new Error("Document count limit");
    }
    if (
      all.reduce((n, d) => n + d.content.length + d.savedContent.length, 0) +
          2 * text.length > 2_000_000
    ) throw new Error("Workspace draft limit reached");
  }
  function add(path: string, text: string) {
    if (
      !path || path.startsWith("/") || path.includes("\\") ||
      path.split("/").some((p) => !p || p === "." || p === "..") ||
      w.documents().some((d) => d.path === path)
    ) throw new Error("Invalid or existing document path");
    capacity(text);
    if (!w.create) throw new Error("Document creation unavailable");
    const d = documentFromText(path, text);
    d.savedContent = "";
    for (const l of languages.values()) {
      if (l.extensions.some((e) => path.endsWith(e))) d.language = l.name;
    }
    w.create(d);
    emit("workspace.changed", { documentId: d.id });
    return d;
  }
  function restoreLanguages(extensions: string[]) {
    for (const extension of extensions) {
      w.language?.(
        [extension],
        documentFromText(`file${extension}`, "").language,
      );
    }
    for (const language of languages.values()) {
      w.language?.(language.extensions, language.name);
    }
  }
  function refresh() {
    w.refresh?.();
  }
  function release(owner: string) {
    for (const [id, v] of views) {
      if (v.owner === owner) {
        views.delete(id);
        w.view?.(v, true);
      }
    }
    for (const [id, d] of diagnostics) {
      if (d.owner === owner) diagnostics.delete(id);
    }
    const removed: string[] = [];
    for (const [id, l] of languages) {
      if (l.owner === owner) {
        removed.push(...l.extensions);
        languages.delete(id);
      }
    }
    restoreLanguages(removed);
    for (const [id, s] of stages) if (s.owner === owner) stages.delete(id);
    refresh();
  }
  function invoke(
    method: string,
    p: Record<string, Json>,
    moduleId: string,
    owner: string,
  ): Json | undefined {
    switch (method) {
      case "editor.getSelection": {
        const d = doc(p.id as string),
          selection = selections.get(d.id) ?? { anchor: 0, head: 0 };
        return {
          id: d.id,
          version: info(d).version,
          anchor: Math.min(selection.anchor, d.content.length),
          head: Math.min(selection.head, d.content.length),
        };
      }
      case "editor.setSelection": {
        const d = requireVersion(p.id as string, p.version as string),
          anchor = p.anchor as number,
          head = p.head as number;
        boundary(d.content, anchor);
        boundary(d.content, head);
        w.open(d.id);
        selections.set(d.id, { anchor, head });
        w.select?.(d.id, anchor, head);
        emit("editor.selection", { id: d.id, anchor, head });
        refresh();
        return null;
      }
      case "editor.close":
        w.close?.(doc(p.id as string).id);
        return null;
      case "documents.create":
        return { ...info(add(p.path as string, p.text as string)) };
      case "languages.register": {
        if (languages.size >= 64 && !languages.has(p.id as string)) {
          throw new Error("Language contribution limit");
        }
        const id = p.id as string;
        if (
          ["markdown", "json"].includes(id) ||
          languages.has(id) && languages.get(id)!.owner !== owner
        ) throw new Error("Language already registered");
        const extensions = p.extensions as string[];
        if (
          extensions.some((e) => !/^\.[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/.test(e))
        ) throw new Error("Invalid extension");
        const previous = languages.get(id)?.extensions ?? [];
        languages.set(id, { owner, id, name: p.name as string, extensions });
        restoreLanguages(previous);
        w.language?.(extensions, p.name as string);
        refresh();
        return null;
      }
      case "languages.remove": {
        const l = languages.get(p.id as string);
        if (l && l.owner !== owner) throw new Error("Language not owned");
        languages.delete(p.id as string);
        if (l) restoreLanguages(l.extensions);
        refresh();
        return null;
      }
      case "languages.list":
        return {
          languages: [
            { id: "markdown", name: "Markdown", extensions: [".md", ".mdx"] },
            { id: "json", name: "JSON", extensions: [".json"] },
            ...[...languages.values()].map(({ id, name, extensions }) => ({
              id,
              name,
              extensions,
            })),
          ],
        };
      case "diagnostics.publish": {
        requireVersion(p.documentId as string, p.version as string);
        const id = key(owner, p.id as string);
        if (diagnostics.size >= 64 && !diagnostics.has(id)) {
          throw new Error("Diagnostics collection limit");
        }
        diagnostics.set(id, {
          id,
          owner,
          moduleId,
          documentId: p.documentId as string,
          version: p.version as string,
          items: p.items as unknown as Diagnostic[],
        });
        refresh();
        emit("diagnostics.changed", { documentId: p.documentId });
        return null;
      }
      case "diagnostics.clear":
        diagnostics.delete(key(owner, p.id as string));
        refresh();
        emit("diagnostics.changed", {});
        return null;
      case "diagnostics.list": {
        const items = currentDiagnostics().filter((d) =>
          p.documentId === undefined || p.documentId === d.documentId
        );
        return {
          collections: items.map((d) => ({ ...d, owner: undefined })).map((
            { owner: _, ...d },
          ) => d) as unknown as Json,
        };
      }
      case "views.publish": {
        const id = key(owner, p.id as string);
        if (views.size >= 32 && !views.has(id)) {
          throw new Error("View contribution limit");
        }
        const blocks = p.blocks as unknown as ViewBlock[];
        if (
          blocks.some((b) =>
            b.kind === "button" &&
            (!b.command?.startsWith(`${moduleId}.`) || b.command.length > 256)
          )
        ) throw new Error("View buttons must reference this module commands");
        const v: ModuleView = {
          id,
          owner,
          moduleId,
          title: p.title as string,
          location: p.location as string,
          blocks,
        };
        const old = views.get(id);
        if (old) w.view?.(old, true);
        views.set(id, v);
        w.view?.(v);
        refresh();
        return null;
      }
      case "views.remove": {
        const id = key(owner, p.id as string), v = views.get(id);
        if (v) {
          views.delete(id);
          w.view?.(v, true);
        }
        refresh();
        return null;
      }
    }
  }
  function internal(
    method: string,
    p: Record<string, Json>,
    owner: string,
  ): Json {
    const now = Date.now();
    for (const [id, s] of stages) if (s.expires < now) stages.delete(id);
    if (method === "release") {
      release(owner);
      return null;
    }
    if (method === "stage.begin" || method === "snapshot.begin") {
      if (stages.size >= 8) throw new Error("Document transfer limit");
      const id = crypto.randomUUID();
      if (method === "snapshot.begin") {
        const d = requireVersion(p.id as string, p.version as string);
        stages.set(id, {
          owner,
          path: d.path,
          text: d.content,
          snapshot: d.id,
          expires: now + 30000,
        });
        return { transfer: id, length: d.content.length };
      }
      stages.set(id, {
        owner,
        path: p.path as string,
        text: "",
        expires: now + 30000,
      });
      return { transfer: id };
    }
    const id = p.transfer as string, s = stages.get(id);
    if (!s || s.owner !== owner) throw new Error("Unknown document transfer");
    s.expires = now + 30000;
    if (method === "transfer.abort") {
      stages.delete(id);
      return null;
    }
    if (method === "stage.chunk") {
      if (
        s.snapshot || p.offset !== s.text.length ||
        typeof p.text !== "string" || p.text.length > 4096 ||
        s.text.length + p.text.length > 256 * 1024
      ) throw new Error("Invalid document chunk");
      s.text += p.text;
      return null;
    }
    if (method === "stage.commit") {
      let d = w.documents().find((d) => d.path === s.path);
      if (d) {
        if (p.replaceVersion) requireVersion(d.id, p.replaceVersion as string);
        else if (d.content !== d.savedContent) {
          throw new Error("Existing document has unsaved edits");
        }
        capacity(s.text, d.id);
        w.edit(d.id, s.text);
      } else d = add(s.path, s.text);
      w.saved?.(d.id, s.text);
      if (typeof p.diskVersion === "string") w.bind?.(d.id, p.diskVersion);
      stages.delete(id);
      w.open(d.id);
      return { ...info(doc(d.id)) };
    }
    if (method === "snapshot.read") {
      const offset = p.offset as number;
      if (
        !Number.isSafeInteger(offset) || offset < 0 || offset > s.text.length
      ) throw new Error("Invalid snapshot range");
      boundary(s.text, offset);
      let end = Math.min(offset + 4096, s.text.length);
      if (end < s.text.length && /[\uD800-\uDBFF]/.test(s.text[end - 1])) end--;
      return {
        text: s.text.slice(offset, end),
        nextOffset: end < s.text.length ? end : null,
      };
    }
    if (method === "snapshot.commit") {
      if (!s.snapshot) throw new Error("Not a snapshot");
      w.saved?.(s.snapshot, s.text);
      if (typeof p.diskVersion === "string") {
        w.bind?.(s.snapshot, p.diskVersion);
      }
      stages.delete(id);
      return { ...info(doc(s.snapshot)) };
    }
    throw new Error("Unknown internal workbench operation");
  }
  function currentDiagnostics() {
    return [...diagnostics.values()].filter((d) =>
      w.documents().some((item) =>
        item.id === d.documentId && info(item).version === d.version
      )
    );
  }
  return {
    invoke,
    internal,
    release,
    views: () => [...views.values()],
    diagnostics: currentDiagnostics,
    selectionFor: (id: string) => selections.get(id),
    remapDocuments(ids: ReadonlyMap<string, string>, removed: ReadonlySet<string>) {
      const current = [...selections];
      selections.clear();
      for (const [id, selection] of current) {
        if (!removed.has(id)) selections.set(ids.get(id) ?? id, selection);
      }
      diagnostics.clear();
      stages.clear();
      refresh();
    },
    action: (id: string, input: Json) => {
      const view = views.get(id);
      if (view) {
        emit("views.action", {
          id: view.id.slice(view.owner.length + 1),
          input,
        }, view.owner);
      }
    },
    reset: () => {
      for (const owner of new Set([...views.values()].map((v) => v.owner))) {
        release(owner);
      }
      diagnostics.clear();
      const extensions = [...languages.values()].flatMap((l) => l.extensions);
      languages.clear();
      restoreLanguages(extensions);
      stages.clear();
      refresh();
    },
    selection: (id: string, anchor: number, head: number) => {
      selections.set(id, { anchor, head });
      emit("editor.selection", { id, anchor, head });
    },
  };
}
