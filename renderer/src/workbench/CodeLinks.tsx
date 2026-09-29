import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { Workspace } from "../workspace/store";
import {
  type CodeSymbol, indexedCodeSymbols, openCodeSymbol, symbolFragment, symbolMarkdown,
} from "../workspace/code_links";
import "./CodeLinks.css";

export function CodeLinks(props: { readonly workspace: Workspace }) {
  const w = props.workspace;
  const [symbols, setSymbols] = createSignal<readonly CodeSymbol[]>([]);
  const [selected, setSelected] = createSignal("");
  const [note, setNote] = createSignal("");
  const [codePath, setCodePath] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const doc = () => w.activeDocument();
  createEffect(() => {
    const document = doc(), revision = w.knowledge.revision();
    const path = document?.kind === "code" ? document.path : codePath();
    setSymbols([]);
    setSelected("");
    setError("");
    let current = true;
    onCleanup(() => { current = false; });
    const source = w.state.documents.find((item) => item.path === path);
    if (!path || !revision || (source &&
      (source.content !== source.savedContent || !source.diskVersion))) return;
    void indexedCodeSymbols(w, path).then((items) => {
      if (current) setSymbols(items.filter((item) => !source || item.version === source.diskVersion));
    }, (failure) => { if (current) setError(String(failure)); });
  });
  const related = createMemo(() => w.knowledge.symbolLinks().filter((edge) =>
    doc()?.kind === "code" ? edge.target === doc()?.path : edge.source === doc()?.path
  ));
  async function link() {
    const symbol = symbols()[Number(selected())];
    const destination = doc()?.kind === "note" ? doc()?.path : note();
    if (!symbol || !destination || busy()) return;
    setBusy(true);
    setError("");
    try {
      const markdown = symbolMarkdown(symbol);
      await w.openFile(destination);
      const target = w.state.documents.find((document) => document.path === destination);
      if (!target || target.kind !== "note") throw new Error("Choose an available note.");
      w.application.invoke("documents.applyEdit", {
        id: target.id, version: w.application.documentVersion(target.id),
        from: target.content.length, to: target.content.length,
        text: `${target.content.endsWith("\n") ? "\n" : "\n\n"}${markdown}\n`,
      }, "maghemite.workbench");
      w.notify(`Linked ${symbol.name} to ${destination}. The note has unsaved changes.`);
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section class="code-links" aria-label="Code and note links">
      <h3>Code links <span>{related().length}</span></h3>
      <Show when={doc()?.kind === "note"}>
        <label>Code file
          <select value={codePath()} onChange={(event) => setCodePath(event.currentTarget.value)}>
            <option value="">Choose a code file</option>
            <For each={w.knowledge.codeFiles()}>{(path) =>
              <option value={path}>{path}</option>
            }</For>
          </select>
        </label>
      </Show>
      <Show when={doc()?.kind === "code" || codePath()}>
        <Show when={symbols().length} fallback={
          <p>Save this file and refresh its index to link a symbol.</p>
        }>
          <label>Symbol
            <select value={selected()} onChange={(event) => setSelected(event.currentTarget.value)}>
              <option value="">Choose a symbol</option>
              <For each={symbols()}>{(symbol, index) =>
                <option value={index()}>{symbol.container ? `${symbol.container}.` : ""}{symbol.name} · L{symbol.line}</option>
              }</For>
            </select>
          </label>
          <Show when={doc()?.kind === "code"}><label>Note
            <select value={note()} onChange={(event) => setNote(event.currentTarget.value)}>
              <option value="">Choose a note</option>
              <For each={w.knowledge.notes()}>{(item) =>
                <option value={item.path}>{item.path}</option>
              }</For>
            </select>
          </label></Show>
          <button class="text-button" disabled={!selected() ||
            (doc()?.kind === "code" && !note()) || busy()} onClick={() => void link()}>
            {busy() ? "Linking…" : doc()?.kind === "note" ? "Link to code" : "Link to note"}
          </button>
        </Show>
      </Show>
      <Show when={related().length} fallback={<p>No symbol links yet.</p>}>
        <For each={related()}>{(edge) =>
          <button class="code-note-link" onClick={() => {
            const action = doc()?.kind === "code"
              ? w.openFile(edge.source)
              : openCodeSymbol(w, edge.target, decodeURIComponent(symbolFragment(edge.symbol)));
            void action.catch((failure) => w.notify(String(failure)));
          }}>
            <strong>{edge.symbol.name}</strong>
            <span>{doc()?.kind === "code" ? edge.source : edge.target}</span>
            <small>Note line {edge.line}</small>
          </button>
        }</For>
      </Show>
      <Show when={error()}><p role="alert">{error()}</p></Show>
    </section>
  );
}
