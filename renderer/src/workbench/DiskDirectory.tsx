import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import type { AppCalls } from "../../../modules-sdk/js/app.ts";
import type { Workspace } from "../workspace/store";
import { Icon } from "../components/Icon";
import { FileActions } from "./FileActions";

type Entry = AppCalls["files.list"]["output"]["entries"][number];

/** Refresh entries in place so unrelated disk changes cannot discard an open form. */
export function DiskDirectory(props: {
  readonly workspace: Workspace;
  readonly path: string;
  readonly depth: number;
  readonly revision: string;
  readonly expanded: () => readonly string[];
  readonly toggleExpanded: (path: string) => void;
}) {
  const [entries, setEntries] = createSignal<Entry[]>([]);
  const [next, setNext] = createSignal<number | null>(0);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  let generation = 0, disposed = false;
  let cancellation: AbortController | undefined;
  onCleanup(() => {
    disposed = true;
    generation++;
    cancellation?.abort();
  });
  async function load(reset = false) {
    if (!reset && (busy() || next() === null)) return;
    let offset = reset ? 0 : next();
    if (offset === null) return;
    cancellation?.abort();
    cancellation = new AbortController();
    const signal = cancellation.signal;
    const own = ++generation, desired = Math.max(1, entries().length);
    setBusy(true);
    setError("");
    try {
      const incoming: Entry[] = [];
      do {
        const page = await props.workspace.files.list(props.path, offset, signal);
        if (disposed || own !== generation) return;
        incoming.push(...page.entries);
        offset = page.nextOffset;
        if (!reset || offset === null || incoming.length >= desired) break;
      } while (offset !== null);
      setEntries((old) => {
        const existing = new Map<string, Entry>(old.map((entry) => [entry.name, entry]));
        const updated = incoming.map((entry) => {
          const previous = existing.get(entry.name);
          return previous?.kind === entry.kind ? previous : entry;
        });
        return reset ? updated : [
          ...old,
          ...updated.filter((entry) => !existing.has(entry.name)),
        ];
      });
      setNext(offset);
    } catch (failure) {
      if (!disposed && own === generation) setError(String(failure));
    } finally {
      if (!disposed && own === generation) setBusy(false);
    }
  }
  createEffect(on(() => props.revision, () => void load(true)));
  return (
    <div role="group" aria-label={props.path || "Workspace files"}>
      <For each={entries()}>
        {(entry) => {
          const path = props.path ? `${props.path}/${entry.name}` : entry.name;
          const directory = entry.kind === "directory";
          const open = () => props.expanded().includes(path);
          return (
            <>
              <div class="file-entry"
                style={{ "padding-left": `${12 + props.depth * 14}px` }}>
                <button type="button" class="file-row" title={path}
                  aria-label={entry.name} aria-expanded={directory ? open() : undefined}
                  disabled={!directory && entry.kind !== "file"}
                  onClick={() => directory
                    ? props.toggleExpanded(path)
                    : void props.workspace.openFile(path)}>
                  <Icon name={directory ? "chevron" : entry.name.endsWith(".md") ? "notes" : "code"}
                    class={open() ? "expanded" : ""} />
                  <span class="truncate">{entry.name}</span>
                </button>
                <Show when={directory || entry.kind === "file"}>
                  <FileActions path={path} kind={directory ? "directory" : "file"}
                    files={props.workspace.files} connected={props.workspace.diskConnected()} />
                </Show>
              </div>
              <Show when={directory && open()}>
                <DiskDirectory workspace={props.workspace} path={path}
                  depth={props.depth + 1} revision={props.revision}
                  expanded={props.expanded} toggleExpanded={props.toggleExpanded} />
              </Show>
            </>
          );
        }}
      </For>
      <Show when={error()}>
        <p class="empty-copy" role="alert">{error()}</p>
        <button type="button" class="text-button" disabled={busy()}
          onClick={() => void load(true)}>Retry</button>
      </Show>
      <Show when={next() !== null && !error()}>
        <button type="button" class="text-button" disabled={busy()}
          onClick={() => void load()}>
          {busy() ? "Loading…" : "Load more files"}
        </button>
      </Show>
      <Show when={!busy() && !error() && !entries().length}>
        <p class="empty-copy">Empty folder</p>
      </Show>
    </div>
  );
}
