import { createSignal, For, Show } from "solid-js";
import { createWorkspaceSearch } from "../workspace/search";
import type { Workspace } from "../workspace/store";
import { Icon } from "../components/Icon";
import "./SearchPanel.css";

export function SearchPanel(props: {
  workspace: Workspace;
  openDocument: (id: string, line?: number) => void;
}) {
  const w = props.workspace, search = createWorkspaceSearch(w);
  const [query, setQuery] = createSignal("");
  const [replacement, setReplacement] = createSignal("");
  const [caseSensitive, setCaseSensitive] = createSignal(false);
  const [regex, setRegex] = createSignal(false);
  const [include, setInclude] = createSignal("");
  const [exclude, setExclude] = createSignal("");
  const [replaceMode, setReplaceMode] = createSignal(false);
  const [fingerprint, setFingerprint] = createSignal("");
  const options = () => ({
    query: query(),
    caseSensitive: caseSensitive(),
    regex: regex(),
    include: include().split(",").map((p) => p.trim()).filter(Boolean),
    exclude: exclude().split(",").map((p) => p.trim()).filter(Boolean),
    ...(replaceMode() ? { replacement: replacement() } : {}),
    maxResults: 1000,
  });
  const stale = () => fingerprint() !== JSON.stringify(options());
  const disabled = () => search.busy() || search.replacing();
  function submit(event: SubmitEvent) {
    event.preventDefault();
    setFingerprint(JSON.stringify(options()));
    void search.run(options());
  }
  return (
    <section class="workspace-search" aria-label="Workspace text search">
      <form onSubmit={submit}>
        <div class="search-field">
          <Icon name="search" />
          <input aria-label="Search workspace" placeholder="Find in files…"
            required value={query()} disabled={search.replacing()}
            onInput={(event) => setQuery(event.currentTarget.value)} />
        </div>
        <div class="search-options">
          <label><input type="checkbox" checked={caseSensitive()}
            onChange={(event) => setCaseSensitive(event.currentTarget.checked)} />Match case</label>
          <label><input type="checkbox" checked={regex()}
            onChange={(event) => setRegex(event.currentTarget.checked)} />Regex</label>
          <label><input type="checkbox" checked={replaceMode()}
            onChange={(event) => setReplaceMode(event.currentTarget.checked)} />Replace</label>
        </div>
        <Show when={replaceMode()}>
          <div class="search-field">
            <input aria-label="Replace with" placeholder="Replace with (empty deletes)…"
              value={replacement()} disabled={search.replacing()}
              onInput={(event) => setReplacement(event.currentTarget.value)} />
          </div>
          <Show when={regex()}>
            <p class="search-hint">Captures: $1, ${"{name}"}. Literal dollar: $$.</p>
          </Show>
        </Show>
        <details class="search-filters">
          <summary>Files to include / exclude</summary>
          <label>Include
            <input placeholder="**/*.ts, **/*.md" value={include()}
              onInput={(event) => setInclude(event.currentTarget.value)} />
          </label>
          <label>Exclude
            <input placeholder="**/generated/**" value={exclude()}
              onInput={(event) => setExclude(event.currentTarget.value)} />
          </label>
          <p class="search-hint">Comma-separated *, ** and ? patterns. Binary files and dependency folders are skipped.</p>
        </details>
        <div class="search-actions">
          <button class="text-button" type="submit" disabled={disabled() || !query()}>
            {replaceMode() ? "Preview replacements" : "Search files"}
          </button>
          <Show when={search.busy()}>
            <button class="text-button" type="button" onClick={() => void search.cancel()}>
              Cancel
            </button>
          </Show>
        </div>
      </form>
      <p class="search-summary" role="status">{search.status()}</p>
      <Show when={search.truncated()}>
        <p class="search-hint">Result limit reached. Narrow the query or file filters.</p>
      </Show>
      <Show when={search.error()}>
        <p class="search-error" role="alert">{search.error()}</p>
      </Show>
      <Show when={search.preview() && !search.busy()}>
        <div class="search-actions">
          <button class="text-button" disabled={disabled() || stale()}
            onClick={search.selectPage}>Select first 32</button>
          <button class="text-button" disabled={disabled()} onClick={search.clear}>Clear</button>
          <button class="text-button" disabled={disabled() || stale() || !search.selected().size}
            onClick={() => void search.replace()}>
            Replace selected ({search.selected().size})
          </button>
        </div>
        <Show when={stale()}>
          <p class="search-hint">Search options changed. Preview again before replacing.</p>
        </Show>
      </Show>
      <For each={search.matches()}>
        {(match) => (
          <div class="search-hit">
            <Show when={search.preview()}>
              <input type="checkbox"
                aria-label={`Select ${match.path}:${match.line}:${match.column + 1}`}
                checked={search.selected().has(match.id)}
                disabled={disabled() || stale() || match.replacementTruncated}
                onChange={() => search.toggle(match.id)} />
            </Show>
            <button class="search-result" title={match.path} onClick={async () => {
              await w.openFile(match.path);
              const doc = w.state.documents.find((d) => d.path === match.path);
              if (!doc) return;
              props.openDocument(doc.id);
              const version = w.application.documentVersion(doc.id);
              if (
                (search.isDraft(match.id) && version !== match.version) ||
                (!search.isDraft(match.id) &&
                  (doc.diskVersion !== match.version || doc.content !== doc.savedContent))
              ) {
                w.notify("This search result changed. Search again for its current position.");
                return;
              }
              w.application.invoke("editor.setSelection", {
                id: doc.id, version, anchor: match.from, head: match.to,
              }, "maghemite.workbench");
            }}>
              <strong>{match.path}<span>:{match.line}:{match.column + 1}</span></strong>
              <span class="truncate">{match.text}{match.textTruncated ? "…" : ""}</span>
              <Show when={search.isDraft(match.id)}>
                <small>{w.workspaceInfo() ? "Unsaved draft" : "Browser document"}</small>
              </Show>
              <Show when={search.preview() && match.replacement !== null}>
                <span class="replacement-preview">→ {match.replacement || "(delete match)"}
                  {match.replacementTruncated ? "… (preview too large)" : ""}</span>
              </Show>
            </button>
          </div>
        )}
      </For>
    </section>
  );
}
