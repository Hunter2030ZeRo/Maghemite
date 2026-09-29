import {
  createEffect,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { TrashEntry } from "../../../modules-sdk/js/file_operations.ts";
import { IconButton } from "../components/Icon";
import type { WorkspaceFiles } from "./FileActions";

const deletionTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function TrashPanel(props: {
  readonly files: WorkspaceFiles;
  readonly connected: boolean;
  readonly close: () => void;
}) {
  const [entries, setEntries] = createSignal<readonly TrashEntry[]>([]);
  const [nextOffset, setNextOffset] = createSignal<number | null>(0);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  let generation = 0;
  let panel: HTMLElement | undefined;

  async function load(offset: number, requestGeneration = generation, refresh = false) {
    if (loading()) return;
    setLoading(true);
    setError("");
    try {
      const incoming: TrashEntry[] = [];
      const desired = Math.max(1, entries().length);
      let cursor: number | null = offset;
      do {
        const page = await props.files.trashList(cursor);
        if (requestGeneration !== generation) return;
        incoming.push(...page.entries);
        cursor = page.nextOffset;
        if (!refresh || cursor === null || incoming.length >= desired) break;
      } while (cursor !== null);
      setEntries((current) => {
        const previous = new Map<string, TrashEntry>(current.map((entry) => [entry.id, entry]));
        const updated = incoming.map((entry) => previous.get(entry.id) ?? entry);
        return offset === 0 ? updated : [
          ...current, ...updated.filter((entry) => !previous.has(entry.id)),
        ];
      });
      setNextOffset(cursor);
    } catch (cause) {
      if (requestGeneration === generation) setError(String(cause));
    } finally {
      if (requestGeneration === generation) setLoading(false);
    }
  }

  createEffect(on(
    () => props.files.revision(),
    () => {
      generation += 1;
      setLoading(false);
      void load(0, generation, true);
    },
  ));
  onMount(() => panel?.focus());
  onCleanup(() => generation++);

  return (
    <section
      class="trash-panel"
      aria-labelledby="trash-panel-heading"
      ref={(element) => {
        panel = element;
      }}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        props.close();
      }}
    >
      <header>
        <div>
          <h2 id="trash-panel-heading">Trash</h2>
          <p>Items remain recoverable. Permanent delete is not available.</p>
        </div>
        <IconButton name="close" label="Close Trash" onClick={props.close} />
      </header>
      <Show
        when={props.connected}
        fallback={
          <p class="empty-copy">
            Desktop disconnected. Trash is unavailable until it reconnects.
          </p>
        }
      >
        <For
          each={entries()}
          fallback={
            <Show when={!loading() && !error()}>
              <p class="empty-copy">Trash is empty.</p>
            </Show>
          }
        >
          {(entry) => (
            <TrashEntryRow
              entry={entry}
              files={props.files}
              connected={props.connected}
              restored={() =>
                setEntries((current) =>
                  current.filter((item) => item.id !== entry.id)
                )}
            />
          )}
        </For>
        <Show when={error()}>
          <div class="trash-list-error">
            <p role="alert">{error()}</p>
            <button
              type="button"
              class="text-button"
              disabled={loading()}
              onClick={() => {
                const offset = entries().length ? nextOffset() ?? 0 : 0;
                void load(offset);
              }}
            >
              Retry
            </button>
          </div>
        </Show>
        <Show when={nextOffset() !== null && !error()}>
          <button
            type="button"
            class="text-button trash-load-more"
            disabled={loading()}
            onClick={() => {
              const offset = nextOffset();
              if (offset !== null) void load(offset);
            }}
          >
            {loading() ? "Loading…" : "Load more"}
          </button>
        </Show>
        <p class="trash-status" role="status" aria-live="polite">
          {loading()
            ? "Loading Trash."
            : `${entries().length} Trash ${
              entries().length === 1 ? "item" : "items"
            } loaded.`}
        </p>
      </Show>
    </section>
  );
}

function TrashEntryRow(props: {
  readonly entry: TrashEntry;
  readonly files: WorkspaceFiles;
  readonly connected: boolean;
  readonly restored: () => void;
}) {
  const [destination, setDestination] = createSignal("");
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal("");

  async function restore(event: SubmitEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const destinationPath = destination().trim();
      await props.files.restore(
        props.entry.id,
        destinationPath || undefined,
      );
      props.restored();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <article class="trash-entry">
      <div class="trash-entry-summary">
        <strong title={props.entry.path}>{props.entry.path}</strong>
        <span>
          {props.entry.kind === "directory" ? "Folder" : "File"} · Deleted{" "}
          <time dateTime={new Date(props.entry.deletedAt).toISOString()}>
            {deletionTime.format(props.entry.deletedAt)}
          </time>
        </span>
      </div>
      <form onSubmit={restore}>
        <label for={`restore-destination-${props.entry.id}`}>
          New destination <span>(optional, for collisions)</span>
        </label>
        <input
          id={`restore-destination-${props.entry.id}`}
          value={destination()}
          disabled={pending()}
          placeholder={props.entry.path}
          onInput={(event) => setDestination(event.currentTarget.value)}
        />
        <div class="file-operation-buttons">
          <button
            type="submit"
            class="text-button"
            disabled={!props.connected || pending() || props.files.busy()}
          >
            {pending() ? "Restoring…" : "Restore"}
          </button>
        </div>
        <Show when={error()}>
          <p class="file-operation-error" role="alert">{error()}</p>
        </Show>
      </form>
    </article>
  );
}
