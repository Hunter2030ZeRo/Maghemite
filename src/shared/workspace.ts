export type DocumentKind = "note" | "code";
export type Activity = "files" | "search" | "notes" | "modules";
export type WorkspaceMode = "develop" | "knowledge";

/** Code and notes share identity/content; presentation belongs to the view. */
export interface WorkspaceDocument {
  id: string;
  path: string;
  kind: DocumentKind;
  language: string;
  content: string;
  savedContent: string;
  /** BLAKE3 content version from the native filesystem, retained across disconnects. */
  diskVersion?: string;
}
export interface ViewTab {
  id: string;
  type: "document" | "graph" | "custom" | "settings";
  documentId?: string;
  view?: {
    editor?: EditorViewState;
    preview?: boolean;
    readingScroll?: number;
  };
}
/** UTF-16 document positions; no document text belongs to a view. */
export interface EditorViewState {
  readonly selections: readonly { readonly anchor: number; readonly head: number }[];
  readonly scrollTop: number;
  readonly scrollLeft: number;
}
export interface EditorGroup {
  id: string;
  tabs: string[];
  activeTab: string | null;
  size: number;
}
export interface Layout {
  primary: boolean;
  secondary: boolean;
  bottom: boolean;
  primaryWidth: number;
  secondaryWidth: number;
  bottomHeight: number;
}
export const defaultLayout: Layout = {
  primary: true,
  secondary: true,
  bottom: false,
  primaryWidth: 236,
  secondaryWidth: 252,
  bottomHeight: 190,
};
export const filename = (path: string) => path.split("/").at(-1) ?? path;
export const stem = (path: string) => filename(path).replace(/\.[^.]+$/, "");
export function documentFromText(
  path: string,
  content: string,
): WorkspaceDocument {
  const extension = path.split(".").at(-1)?.toLowerCase();
  const kind = extension === "md" || extension === "mdx" ? "note" : "code";
  const languages: Record<string, string> = {
    ts: "TypeScript",
    tsx: "TSX",
    js: "JavaScript",
    rs: "Rust",
    py: "Python",
    json: "JSON",
    css: "CSS",
    html: "HTML",
  };
  return {
    id: path,
    path,
    kind,
    language: kind === "note"
      ? "Markdown"
      : languages[extension ?? ""] ?? "Plain text",
    content,
    savedContent: content,
  };
}
export function headings(content: string) {
  let fenced = false;
  return content.split("\n").flatMap((line, index) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      return [];
    }
    const match = !fenced && /^(#{1,6})\s+(.+)$/.exec(line);
    return match
      ? [{ level: match[1].length, text: match[2], line: index + 1 }]
      : [];
  });
}
export function createLinkResolver<T extends { path: string }>(documents: T[]) {
  const paths = new Map(documents.map((d) => [d.path, d]));
  const names = new Map<string, T | undefined>();
  for (const doc of documents) {
    const name = stem(doc.path).toLowerCase();
    names.set(name, names.has(name) ? undefined : doc);
  }
  return (target: string, source?: { path: string }): T | undefined => {
    let clean = target.split("|")[0].split("#")[0].trim();
    try {
      clean = decodeURIComponent(clean);
    } catch {
      return;
    }
    if (!clean) return source ? paths.get(source.path) : undefined;
    if (
      /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith("//") ||
      clean.includes("\\")
    ) return;
    const normalize = (path: string) => {
      const parts: string[] = [];
      for (const part of path.split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") {
          if (!parts.length) return undefined;
          parts.pop();
        } else parts.push(part);
      }
      return parts.join("/");
    };
    const directory = source?.path.slice(0, source.path.lastIndexOf("/") + 1) ??
      "";
    const relative = normalize(
      clean.startsWith("/") ? clean : directory + clean,
    );
    const root = normalize(clean);
    for (const path of [relative, root]) {
      if (path === undefined) continue;
      const exact = paths.get(path) ?? paths.get(`${path}.md`) ??
        paths.get(`${path}.mdx`);
      if (exact) return exact;
    }
    // Bare wiki names may resolve uniquely; duplicate names must never choose a random note.
    if (clean.includes("/")) return;
    return names.get(clean.replace(/\.mdx?$/i, "").toLowerCase());
  };
}
export function resolveLink<T extends { path: string }>(
  target: string,
  documents: T[],
  source?: { path: string },
) {
  return createLinkResolver(documents)(target, source);
}
export function linkTargets(
  content: string,
): { target: string; line: number }[] {
  let fence: string | undefined;
  return content.split("\n").flatMap((line, index) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined;
      }
      return [];
    }
    if (fence) return [];
    return [
      ...line.replace(/`[^`]*`/g, "").matchAll(
        /\[\[([^\]]+)\]\]|!?\[[^\]]*\]\(<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g,
      ),
    ].map((match) => ({ target: match[1] ?? match[2], line: index + 1 }));
  });
}
export function links(documents: WorkspaceDocument[]) {
  const resolve = createLinkResolver(documents);
  return documents.filter((source) => source.kind === "note").flatMap((
    source,
  ) =>
    linkTargets(source.content).flatMap((link) => {
      const target = resolve(link.target, source);
      return target ? [{ source: source.id, target: target.id }] : [];
    })
  ).filter((edge, i, all) =>
    all.findIndex((other) =>
      other.source === edge.source && other.target === edge.target
    ) === i
  );
}

interface SessionData {
  documents: WorkspaceDocument[];
  tabs: ViewTab[];
  activeTab: string | null;
  mode: WorkspaceMode;
  layout: Layout;
}
export interface LegacySession extends SessionData {
  version: 1;
  groups?: never;
  activeGroup?: never;
}
export interface GroupSession extends SessionData {
  version: 2;
  groups: EditorGroup[];
  activeGroup: string;
}
export type Session = LegacySession | GroupSession;
export const MAX_EDITOR_GROUPS = 4;
export const MAX_EDITOR_TABS = 408;

/** Persisted browser data is untrusted; reject malformed or oversized sessions. */
export function decodeSession(raw: string | null): Session | undefined {
  if (!raw || raw.length > 3_000_000) return;
  try {
    const s = JSON.parse(raw);
    if (
      !s || ![1, 2].includes(s.version) ||
      !Array.isArray(s.documents) || s.documents.length > 100
    ) return;
    if (
      s.documents.some((d: WorkspaceDocument) =>
        !d || typeof d.path !== "string" || d.id !== d.path ||
        typeof d.content !== "string" || typeof d.savedContent !== "string" ||
        typeof d.language !== "string" || !["note", "code"].includes(d.kind) ||
        (d.diskVersion !== undefined &&
          (typeof d.diskVersion !== "string" ||
            !/^[a-f0-9]{64}$/.test(d.diskVersion)))
      )
    ) return;
    const ids = new Set(s.documents.map((d: WorkspaceDocument) => d.id));
    if (
      ids.size !== s.documents.length || !Array.isArray(s.tabs) ||
      s.tabs.length > (s.version === 1 ? 102 : MAX_EDITOR_TABS)
    ) return;
    if (
      s.tabs.some((t: ViewTab) =>
        !t ||
        (s.version === 1 ? (t.type === "graph"
          ? t.id !== "graph"
          : t.type === "settings"
          ? t.id !== "settings"
          : t.type !== "document" || t.id !== `doc:${t.documentId}` ||
            !ids.has(t.documentId)) :
          typeof t.id !== "string" || !t.id || t.id.length > 2048 ||
          !["document", "graph", "settings"].includes(t.type) ||
          (t.type === "document" && !ids.has(t.documentId)) ||
          (t.type !== "document" && t.documentId !== undefined) ||
          !validViewState(t.view))
      )
    ) return;
    if (new Set(s.tabs.map((t: ViewTab) => t.id)).size !== s.tabs.length) {
      return;
    }
    if (
      s.activeTab !== null && !s.tabs.some((t: ViewTab) => t.id === s.activeTab)
    ) return;
    if (s.version === 2) {
      if (!Array.isArray(s.groups) || !s.groups.length ||
        s.groups.length > MAX_EDITOR_GROUPS) return;
      const tabIds = new Set(s.tabs.map((tab: ViewTab) => tab.id));
      const members = new Set<string>(), groups = new Set<string>();
      for (const group of s.groups) {
        if (!group || typeof group.id !== "string" || !group.id ||
          group.id.length > 128 || groups.has(group.id) ||
          !Number.isFinite(group.size) || group.size <= 0 || group.size > 1 ||
          !Array.isArray(group.tabs) || group.tabs.length > MAX_EDITOR_TABS ||
          (group.tabs.length === 0 ? group.activeTab !== null :
            !group.tabs.includes(group.activeTab))) return;
        groups.add(group.id);
        for (const id of group.tabs) {
          if (!tabIds.has(id) || members.has(id)) return;
          members.add(id);
        }
      }
      if (members.size !== tabIds.size || !groups.has(s.activeGroup) ||
        s.groups.find((group: EditorGroup) => group.id === s.activeGroup)?.activeTab !== s.activeTab) return;
    }
    if (!["develop", "knowledge"].includes(s.mode)) return;
    const l = s.layout;
    if (
      !l ||
      ["primary", "secondary", "bottom"].some((k) => typeof l[k] !== "boolean")
    ) return;
    for (
      const [key, min, max] of [["primaryWidth", 190, 360], [
        "secondaryWidth",
        210,
        360,
      ], ["bottomHeight", 120, 400]] as const
    ) {
      if (!Number.isFinite(l[key]) || l[key] < min || l[key] > max) return;
    }
    return s;
  } catch {
    return;
  }
}

function validViewState(value: ViewTab["view"]): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  if (value.preview !== undefined && typeof value.preview !== "boolean") return false;
  const scroll = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1_000_000_000;
  if (value.readingScroll !== undefined && !scroll(value.readingScroll)) return false;
  if (value.editor === undefined) return true;
  const editor = value.editor;
  return !!editor && scroll(editor.scrollTop) && scroll(editor.scrollLeft) &&
    Array.isArray(editor.selections) && editor.selections.length > 0 &&
    editor.selections.length <= 1000 && editor.selections.every((selection) =>
      !!selection && Number.isSafeInteger(selection.anchor) && selection.anchor >= 0 &&
      Number.isSafeInteger(selection.head) && selection.head >= 0);
}
