import { createEffect, createSignal, on, onCleanup } from "solid-js";
import { createAppAPI } from "../../../modules-sdk/js/app.ts";
import type { SearchMatch } from "../../../modules-sdk/js/search.ts";
import type { Workspace } from "./store";
import { searchDraftsAsync } from "./search-async";
import {
  draftReplacementEdits,
  SearchError,
  type SearchOptions,
  type SearchSnapshot,
} from "./search-text";

export function createWorkspaceSearch(w: Workspace) {
  const api = createAppAPI(w.request);
  const [matches, setMatches] = createSignal<readonly SearchMatch[]>([]);
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = createSignal(false);
  const [replacing, setReplacing] = createSignal(false);
  const [status, setStatus] = createSignal("Search code and notes, including unopened files.");
  const [error, setError] = createSignal("");
  const [truncated, setTruncated] = createSignal(false);
  const [preview, setPreview] = createSignal(false);
  let generation = 0, search: string | undefined;
  let draftSearch: AbortController | undefined;
  let snapshots: SearchSnapshot[] = [];
  const draftIds = new Set<string>();
  const dirtyPaths = () => w.state.documents.filter((d) =>
    !d.diskVersion || d.content !== d.savedContent
  ).map((d) => d.path);

  async function release(id: string) {
    try {
      await api.request("search.release", { search: id });
    } catch (failure) {
      if (w.diskConnected()) w.notify(`Search cleanup failed: ${String(failure)}`);
    }
  }
  async function cancel() {
    generation++;
    draftSearch?.abort();
    draftSearch = undefined;
    const previous = search;
    search = undefined;
    if (busy()) setStatus("Search cancelled.");
    setBusy(false);
    setPreview(false);
    setSelected(new Set<string>());
    if (previous && w.diskConnected()) await release(previous);
  }
  async function run(options: SearchOptions) {
    const cancelled = cancel();
    const own = generation;
    await cancelled;
    if (own !== generation) return;
    setMatches([]);
    setError("");
    setTruncated(false);
    setPreview(options.replacement !== undefined);
    setBusy(true);
    setStatus("Searching…");
    draftIds.clear();
    snapshots = w.state.documents.filter((doc) =>
      !w.workspaceInfo() || !doc.diskVersion || doc.content !== doc.savedContent
    ).map((doc) => ({
      id: doc.id,
      path: doc.path,
      content: doc.content,
      version: w.application.documentVersion(doc.id),
    }));
    try {
      draftSearch = new AbortController();
      const local = await searchDraftsAsync(snapshots, options, draftSearch.signal, () => {
        if (own === generation) setStatus("Searching drafts…");
      });
      if (own !== generation) return;
      draftSearch = undefined;
      local.matches.forEach((match) => draftIds.add(match.id));
      setMatches(local.matches);
      setTruncated(local.truncated);
      if (w.workspaceInfo()) {
        setStatus("Searching disk files…");
        const started = await api.request("search.start", {
          ...options,
          skipPaths: snapshots.map((doc) => doc.path),
        });
        if (own !== generation) {
          await release(started.search);
          return;
        }
        search = started.search;
        let cursor = 0;
        for (;;) {
          const page = await api.request("search.read", {
            search: started.search,
            cursor,
            waitMs: 1000,
          });
          if (own !== generation) return;
          setMatches((old) => [...old, ...page.matches]);
          setTruncated((old) => old || page.truncated);
          setStatus(`${matches().length} matches · ${page.scannedFiles} files searched${
            page.skippedFiles ? ` · ${page.skippedFiles} skipped` : ""
          }`);
          cursor = page.cursor;
          if (page.error) throw new SearchError(page.error);
          if (page.cancelled) setStatus("Search cancelled.");
          if (page.done) break;
        }
      } else {
        setStatus(`${matches().length} matches in browser documents.`);
      }
    } catch (failure) {
      if (own === generation) {
        setStatus("Search failed.");
        setError(String(failure));
        setPreview(false);
      }
    } finally {
      if (own === generation) {
        draftSearch = undefined;
        setBusy(false);
      }
    }
  }
  function toggle(id: string) {
    setSelected((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function selectPage() {
    setSelected(new Set(matches().filter((m) =>
      m.replacement !== null && !m.replacementTruncated
    ).slice(0, 32).map((m) => m.id)));
  }
  async function replace() {
    if (busy() || replacing() || !preview() || !selected().size) return;
    const chosen = matches().filter((m) => selected().has(m.id));
    const draft = chosen.filter((m) => draftIds.has(m.id));
    const disk = chosen.filter((m) => !draftIds.has(m.id));
    const own = generation;
    setError("");
    setReplacing(true);
    try {
      const edits = draftReplacementEdits(draft, snapshots, w.application.documentVersion);
      if (disk.length > 256) throw new SearchError("Select at most 256 disk matches.");
      if (disk.length && !search) throw new SearchError("Search again before replacing.");
      if (edits.length) {
        w.application.invoke("documents.applyEdits", { edits }, "maghemite.workbench");
      }
      let applied = draft.length;
      const failures: string[] = [];
      if (search && disk.length) {
        const clean = new Map(w.state.documents.filter((d) =>
          d.diskVersion && d.content === d.savedContent
        ).map((d) => [d.id, w.application.documentVersion(d.id)]));
        const result = await api.request("search.replace", {
          search,
          resultIds: disk.map((match) => match.id),
          skipPaths: dirtyPaths(),
        });
        if (own !== generation) return;
        for (const file of result.files) {
          if (file.status !== "applied") {
            failures.push(`${file.path}: ${file.error ?? file.status}`);
            continue;
          }
          applied += file.replacements;
          const doc = w.state.documents.find((d) => d.path === file.path);
          if (doc && clean.get(doc.id) === w.application.documentVersion(doc.id)) {
            await w.reloadFile(doc.id);
          }
        }
      }
      if (own !== generation) return;
      setStatus(`Replaced ${applied} matches.${draft.length ? " Draft changes are unsaved." : ""} Search again for fresh results.`);
      setPreview(false);
      setSelected(new Set<string>());
      if (failures.length) setError(failures.join("\n"));
      if (w.workspaceInfo()) await w.knowledge.refresh();
    } catch (failure) {
      if (own === generation) {
        setPreview(false);
        setError(`${String(failure)} Search again before retrying; files commit independently.`);
      }
    } finally {
      setReplacing(false);
    }
  }
  createEffect(on(() => [w.workspaceInfo()?.id, w.diskConnected()], () => {
    void cancel();
    setMatches([]);
  }));
  onCleanup(() => void cancel());
  return {
    matches, selected, busy, replacing, status, error, truncated, preview,
    run, cancel, toggle, selectPage, replace,
    clear: () => setSelected(new Set<string>()),
    isDraft: (id: string) => draftIds.has(id),
  };
}
