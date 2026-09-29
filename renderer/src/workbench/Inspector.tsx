import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import type { Workspace } from "../workspace/store";
import { headings, stem } from "../workspace/model";
import { Icon } from "../components/Icon";
import { CodeLinks } from "./CodeLinks";

export function Inspector(
  props: { workspace: Workspace; jump: (line: number) => void },
) {
  const w = props.workspace;
  const [open, setOpen] = createSignal({
    outline: true,
    backlinks: true,
    details: true,
  });
  const [symbols, setSymbols] = createSignal<
    { level: number; text: string; line: number }[]
  >([]);
  createEffect(() => {
    const doc = w.activeDocument(), revision = w.knowledge.revision();
    setSymbols([]);
    let stale = false;
    if (doc?.kind === "code" && revision && doc.content === doc.savedContent) {
      void w.request("index.query", { kind: "symbols", path: doc.path }).then(
        (data) => {
          if (!stale) {
            setSymbols(
              (data as unknown as { items: { name: string; line: number }[] })
                .items.map((s) => ({ level: 1, text: s.name, line: s.line })),
            );
          }
        },
      ).catch(() => {});
    }
    onCleanup(() => {
      stale = true;
    });
  });
  const outline = createMemo(() =>
    w.activeDocument()?.kind === "code"
      ? symbols()
      : headings(w.activeDocument()?.content ?? "")
  );
  const backlinks = createMemo(() =>
    w.knowledge.edges().filter((l) => l.target === w.activeDocument()?.id)
      .map((l) => ({ id: l.source, path: l.source }))
  );
  return (
    <aside class="secondary-sidebar" aria-label="Document context">
      <div class="panel-heading">
        Context<Icon name="notes" />
      </div>
      <Show
        when={w.activeDocument()}
        fallback={
          <div class="empty-copy">
            Open a document to see its outline and connections.
          </div>
        }
      >
        {(doc) => (
          <>
            <div class="context-document">
              <Icon name={doc().kind === "note" ? "notes" : "code"} />
              <strong>{stem(doc().path)}</strong>
              <span>{doc().language}</span>
            </div>
            <button
              class="context-section-heading"
              aria-expanded={open().outline}
              onClick={() => setOpen((s) => ({ ...s, outline: !s.outline }))}
            >
              <Icon
                name="chevron"
                class={open().outline ? "expanded" : ""}
              />Outline<span>{outline().length}</span>
            </button>
            <Show when={open().outline}>
              <div class="outline">
                <For
                  each={outline()}
                  fallback={
                    <p class="empty-copy">
                      {doc().kind === "code"
                        ? "Save this file to refresh indexed symbols. Up to 20 symbols are shown."
                        : "Add a heading to outline this note."}
                    </p>
                  }
                >
                  {(heading) => (
                    <button
                      style={{
                        "padding-left": `${
                          14 + Math.min(heading.level - 1, 3) * 12
                        }px`,
                      }}
                      onClick={() => props.jump(heading.line)}
                    >
                      <span class="heading-marker">
                        {heading.level === 1 ? "H1" : "·"}
                      </span>
                      <span>{heading.text}</span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <button
              class="context-section-heading"
              aria-expanded={open().backlinks}
              onClick={() =>
                setOpen((s) => ({ ...s, backlinks: !s.backlinks }))}
            >
              <Icon
                name="chevron"
                class={open().backlinks ? "expanded" : ""}
              />Backlinks<span>{backlinks().length}</span>
            </button>
            <Show when={open().backlinks}>
              <div class="backlinks">
                <For
                  each={backlinks()}
                  fallback={
                    <p class="empty-copy">
                      Notes linking here will appear in this space.
                    </p>
                  }
                >
                  {(source) => (
                    <button onClick={() => w.openFile(source.id)}>
                      <Icon name="link" />
                      <div>
                        <strong>{stem(source.path)}</strong>
                        <small>Linked mention</small>
                      </div>
                      <Icon name="arrow" />
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <button
              class="context-section-heading"
              aria-expanded={open().details}
              onClick={() => setOpen((s) => ({ ...s, details: !s.details }))}
            >
              <Icon
                name="chevron"
                class={open().details ? "expanded" : ""}
              />Document
            </button>
            <Show when={open().details}>
              <dl class="document-details">
                <dt>Words</dt>
                <dd>
                  {doc().content.trim().split(/\s+/).filter(Boolean).length}
                </dd>
                <dt>Lines</dt>
                <dd>{doc().content.split("\n").length}</dd>
                <dt>Format</dt>
                <dd>{doc().language}</dd>
                <dt>Storage</dt>
                <dd>
                  {w.diskDocuments().includes(doc().id)
                    ? "Disk file"
                    : "Browser draft"}
                </dd>
              </dl>
            </Show>
            <CodeLinks workspace={w} />
            <div class="context-tip">
              <Icon name="link" />
              <p>
                Ideas grow together.<br />
                <span>Connect a note with [[a link]].</span>
              </p>
            </div>
          </>
        )}
      </Show>
    </aside>
  );
}
