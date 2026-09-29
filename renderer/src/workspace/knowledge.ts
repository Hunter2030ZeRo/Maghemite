import { createMemo, createSignal, onCleanup } from "solid-js";
import {
  createLinkResolver,
  linkTargets,
  type WorkspaceDocument,
} from "./model";
import type { Json } from "../../../modules-sdk/js/mod.ts";
import { codeEdges } from "./code_links.ts";
export function createKnowledge(
  documents: () => WorkspaceDocument[],
  request: (method: string, parameters?: Json) => Promise<Json>,
) {
  const [paths, setPaths] = createSignal<string[]>([]),
    [indexedLinks, setLinks] = createSignal<
      { source: string; target: string; line: number }[]
    >([]);
  const [status, setStatus] = createSignal("Open-document graph"),
    [revision, setRevision] = createSignal("");
  const [truncated, setTruncated] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined,
    generation = 0,
    loading = false;
  async function refresh() {
    if (loading) return;
    loading = true;
    const own = generation;
    try {
      const health = await request("index.status") as {
        phase: string;
        error?: string;
      };
      if (health.phase === "failed") {
        throw new Error(health.error ?? "Index failed");
      }
      const first = await request("index.query", {
        kind: "files",
        offset: 0,
      }) as {
        items: { path: string }[];
        nextOffset: number | null;
        revision: string;
      };
      if (own !== generation) return;
      if (first.revision === revision()) {
        setStatus(
          truncated()
            ? "Index display limit reached (10,000 records per category)"
            : "Workspace index connected",
        );
        return;
      }
      setStatus("Reading workspace index…");
      let limited = false;
      async function pages<T>(
        kind: string,
        limit: number,
        initial?: { items: T[]; nextOffset: number | null; revision: string },
      ) {
        const all: T[] = [];
        let offset = 0;
        do {
          const page = initial ??
            await request("index.query", { kind, offset }) as {
              items: T[];
              nextOffset: number | null;
              revision: string;
            };
          initial = undefined;
          if (own !== generation) throw new Error("Workspace changed");
          if (page.revision !== first.revision) {
            throw new Error("Index changed during reading; retrying");
          }
          all.push(...page.items);
          if (page.nextOffset === null) break;
          if (all.length >= limit) {
            limited = true;
            break;
          }
          offset = page.nextOffset;
        } while (true);
        return all;
      }
      const files = await pages<{ path: string }>("files", 10_000, first);
      const edges = await pages<
        { source: string; target: string; line: number }
      >("links", 10_000);
      if (own !== generation) return;
      setPaths(files.map((f) => f.path));
      setLinks(edges);
      setTruncated(limited);
      setRevision(first.revision);
      setStatus(
        limited
          ? "Index display limit reached (10,000 records per category)"
          : "Workspace index connected",
      );
    } catch (error) {
      if (own === generation) setStatus(String(error));
    } finally {
      loading = false;
    }
  }
  const notes = createMemo(() =>
    [
      ...new Set([
        ...paths().filter((path) => /\.mdx?$/i.test(path)),
        ...documents().filter((d) => d.kind === "note").map((d) => d.path),
      ]),
    ].sort().map((path) => ({ id: path, path }))
  );
  const codeFiles = createMemo(() => [
    ...new Set([
      ...paths().filter((path) => !/\.mdx?$/i.test(path)),
      ...documents().filter((document) => document.kind === "code").map((document) => document.path),
    ]),
  ].sort());
  const rawLinks = createMemo(() => {
    const open = documents().filter((d) =>
        d.kind === "note" &&
        (!revision() || !d.diskVersion || d.content !== d.savedContent)
      ),
      openPaths = new Set(open.map((d) => d.path));
    return [
      ...indexedLinks().filter((edge) => !openPaths.has(edge.source)),
      ...open.flatMap((d) =>
        linkTargets(d.content).map((link) => ({ ...link, source: d.path }))
      ),
    ];
  });
  const symbolLinks = createMemo(() => codeEdges(
    rawLinks(), [...new Set([...paths(), ...documents().map((document) => document.path)])],
  ));
  const edges = createMemo(() => {
    const unique = new Map<
      string,
      { source: string; target: string; line: number }
    >();
    const resolve = createLinkResolver(notes()),
      notePaths = new Set(notes().map((n) => n.path));
    for (const edge of rawLinks()) {
      const target = resolve(edge.target, { path: edge.source });
      if (target && notePaths.has(edge.source)) {
        unique.set(`${edge.source}\0${target.path}`, {
          source: edge.source,
          target: target.path,
          line: edge.line,
        });
      }
    }
    return [...unique.values()];
  });
  function disconnect() {
    generation++;
    clearTimeout(timer);
    setStatus("Offline · cached graph");
  }
  async function poll(own: number) {
    await refresh();
    if (own === generation) timer = setTimeout(() => void poll(own), 5000);
  }
  onCleanup(disconnect);
  return {
    notes,
    codeFiles,
    edges,
    symbolLinks,
    status,
    revision,
    truncated,
    refresh,
    connect() {
      disconnect();
      setRevision("");
      void poll(generation);
    },
    disconnect,
    reset() {
      disconnect();
      setPaths([]);
      setLinks([]);
      setRevision("");
    },
  };
}
