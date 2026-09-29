import {
  createLinkResolver,
  documentFromText,
  filename,
  type Session,
} from "./workspace.ts";

export type FileMove = { readonly from: string; readonly to: string };
export type FileVersionChange = {
  readonly path: string;
  readonly previousVersion: string;
  readonly version: string;
};
export type FileSessionChange = {
  readonly session: Session;
  readonly ids: ReadonlyMap<string, string>;
  readonly removed: ReadonlySet<string>;
  readonly recovered: readonly string[];
};
export class FileMoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileMoveError";
  }
}

export function movedPath(path: string, move: FileMove): string {
  return path === move.from || path.startsWith(`${move.from}/`)
    ? move.to + path.slice(move.from.length)
    : path;
}
export function containsPath(parent: string, path: string): boolean {
  return parent === path || path.startsWith(`${parent}/`);
}

function relativeLink(source: string, target: string): string {
  const directory = source.split("/").slice(0, -1);
  const parts = target.split("/");
  while (directory.length && directory[0] === parts[0]) {
    directory.shift();
    parts.shift();
  }
  return [...directory.map(() => ".."), ...parts].join("/");
}

/** Rewrite resolvable note targets, preserving labels, fragments and code examples. */
export function rewriteMovedLinks(
  content: string,
  source: string,
  move: FileMove,
  paths: readonly string[],
): string {
  const before = paths.map((path) => ({ path }));
  const after = before.map(({ path }) => ({ path: movedPath(path, move) }));
  const resolveBefore = createLinkResolver(before);
  const resolveAfter = createLinkResolver(after);
  const nextSource = movedPath(source, move);
  function target(raw: string, wiki: boolean) {
    const trimmed = raw.trim();
    const found = resolveBefore(trimmed, { path: source });
    if (!found) return raw;
    const next = movedPath(found.path, move);
    if (resolveAfter(trimmed, { path: nextSource })?.path === next) return raw;
    const fragment = trimmed.includes("#") ? trimmed.slice(trimmed.indexOf("#")) : "";
    const path = wiki || trimmed.startsWith("/")
      ? `/${next}`
      : relativeLink(nextSource, next);
    return raw.replace(trimmed, `${wiki ? path : encodeURI(path)}${fragment}`);
  }
  let fence = "";
  return content.split(/(?<=\n)/).map((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = "";
      return line;
    }
    if (fence) return line;
    return line.replace(
      /`+[^`]*`+|\\.|(?:\[\[([^\]|]+)(\|[^\]]*)?\]\])|(?:!?\[[^\]]*\]\(<?([^\s)>]+)>?(?:\s+[^)]*)?\))/g,
      (whole: string, wiki: string | undefined, alias: string | undefined, markdown: string | undefined) => {
        if (wiki !== undefined) return `[[${target(wiki, true)}${alias ?? ""}]]`;
        if (markdown !== undefined) {
          const opening = whole.indexOf("](") + 2;
          const start = opening + (whole[opening] === "<" ? 1 : 0);
          return whole.slice(0, start) + target(markdown, false) +
            whole.slice(start + markdown.length);
        }
        return whole;
      },
    );
  }).join("");
}

export function rewriteDeletedLinks(
  content: string,
  source: string,
  deleted: string,
  paths: readonly string[],
): string {
  const resolve = createLinkResolver(paths.map((path) => ({ path })));
  let fence = "";
  return content.split(/(?<=\n)/).map((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = "";
      return line;
    }
    if (fence) return line;
    return line.replace(
      /`+[^`]*`+|\\.|(?:\[\[([^\]|]+)(\|[^\]]*)?\]\])|(?:(!?)\[([^\]]*)\]\(<?([^\s)>]+)>?(?:\s+[^)]*)?\))/g,
      (whole: string, wiki: string | undefined, alias: string | undefined,
        image: string | undefined, label: string | undefined, markdown: string | undefined) => {
        const target = wiki ?? markdown;
        if (target === undefined || !containsPath(deleted,
          resolve(target, { path: source })?.path ?? "")) return whole;
        if (wiki !== undefined) return alias ? alias.slice(1) : wiki.split("#")[0].split("/").at(-1) ?? "";
        return image ? "" : label ?? "";
      },
    );
  }).join("");
}

export function moveSession(
  session: Session,
  move: FileMove,
  paths: readonly string[],
  versions: readonly FileVersionChange[] = [],
): FileSessionChange {
  const ids = new Map<string, string>();
  const seen = new Set<string>();
  const updates = new Map(versions.map((v) => [v.path, v]));
  const documents = session.documents.map((doc) => {
    const path = movedPath(doc.path, move);
    if (seen.has(path)) throw new FileMoveError(`An open draft already uses ${path}`);
    seen.add(path);
    if (path !== doc.path) ids.set(doc.id, path);
    const next = documentFromText(path, doc.content);
    const version = updates.get(path);
    const diskUpdated = version && doc.diskVersion === version.previousVersion;
    return {
      ...doc,
      id: path,
      path,
      kind: next.kind,
      language: path.split(".").at(-1) === doc.path.split(".").at(-1)
        ? doc.language
        : next.language,
      content: doc.kind === "note"
        ? rewriteMovedLinks(doc.content, doc.path, move, paths)
        : doc.content,
      savedContent: diskUpdated && doc.kind === "note"
        ? rewriteMovedLinks(doc.savedContent, doc.path, move, paths)
        : doc.savedContent,
      diskVersion: diskUpdated ? version.version : doc.diskVersion,
    };
  });
  const tabs = session.tabs.map((tab) => {
    const id = tab.documentId && ids.get(tab.documentId);
    return id ? { ...tab, id: session.version === 1 ? `doc:${id}` : tab.id, documentId: id } : tab;
  });
  const active = session.tabs.find((tab) => tab.id === session.activeTab);
  const activeId = active?.documentId && ids.get(active.documentId);
  return {
    session: {
      ...session, documents, tabs,
      activeTab: activeId && session.version === 1 ? `doc:${activeId}` : session.activeTab,
    },
    ids,
    removed: new Set(),
    recovered: [],
  };
}

export function trashSession(
  session: Session,
  path: string,
  trashId: string,
  paths: readonly string[],
  versions: readonly FileVersionChange[] = [],
): FileSessionChange {
  const ids = new Map<string, string>(), removed = new Set<string>();
  const updates = new Map(versions.map((change) => [change.path, change]));
  const occupied = new Set([...paths, ...session.documents.map((doc) => doc.path)]);
  const recovered: string[] = [];
  const documents = session.documents.flatMap((doc) => {
    if (!containsPath(path, doc.path)) {
      if (doc.kind !== "note") return [doc];
      const version = updates.get(doc.path);
      const diskUpdated = version && doc.diskVersion === version.previousVersion;
      return [{
        ...doc,
        content: rewriteDeletedLinks(doc.content, doc.path, path, paths),
        savedContent: diskUpdated
          ? rewriteDeletedLinks(doc.savedContent, doc.path, path, paths)
          : doc.savedContent,
        diskVersion: diskUpdated ? version.version : doc.diskVersion,
      }];
    }
    if (doc.content === doc.savedContent) {
      removed.add(doc.id);
      return [];
    }
    const base = `Recovered-${trashId.slice(0, 12)}-${filename(doc.path)}`;
    let destination = base, suffix = 1;
    while (occupied.has(destination)) destination = `${suffix++}-${base}`;
    occupied.add(destination);
    ids.set(doc.id, destination);
    recovered.push(destination);
    return [{
      ...doc,
      id: destination,
      path: destination,
      content: doc.kind === "note"
        ? rewriteMovedLinks(doc.content, doc.path, { from: doc.path, to: destination }, paths)
        : doc.content,
      savedContent: "",
      diskVersion: undefined,
    }];
  });
  const tabs = session.tabs.filter((tab) =>
    !tab.documentId || !removed.has(tab.documentId)
  ).map((tab) => {
    const id = tab.documentId && ids.get(tab.documentId);
    return id ? { ...tab, id: session.version === 1 ? `doc:${id}` : tab.id, documentId: id } : tab;
  });
  const current = session.tabs.find((tab) => tab.id === session.activeTab);
  const mapped = current?.documentId && ids.get(current.documentId);
  const activeTab = mapped ? `doc:${mapped}` : session.activeTab;
  if (session.version === 2) {
    const retained = new Set(tabs.map((tab) => tab.id));
    const groups = session.groups.map((group) => {
      const members = group.tabs.filter((id) => retained.has(id));
      return { ...group, tabs: members,
        activeTab: group.activeTab && retained.has(group.activeTab) ? group.activeTab : members[0] ?? null };
    });
    return {
      session: { ...session, documents, tabs, groups,
        activeTab: groups.find((group) => group.id === session.activeGroup)?.activeTab ?? null },
      ids, removed, recovered,
    };
  }
  return {
    session: {
      ...session, documents, tabs,
      activeTab: tabs.some((tab) => tab.id === activeTab) ? activeTab : tabs[0]?.id ?? null,
    },
    ids, removed, recovered,
  };
}
