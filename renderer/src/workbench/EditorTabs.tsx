import { createEffect, For, onCleanup, onMount, Show } from "solid-js";
import { Icon, IconButton } from "../components/Icon";
import { type EditorGroup, filename } from "../workspace/model";
import type { Workspace } from "../workspace/store";

export const EDITOR_TAB_DRAG = "application/x-maghemite-editor-tab";

export function EditorTabs(props: {
  workspace: Workspace;
  group: EditorGroup;
  label: string;
  onCreate: () => void;
}) {
  const w = props.workspace;
  const tabs = () => props.group.tabs.flatMap((id) => {
    const tab = w.state.tabs.find((tab) => tab.id === id);
    return tab ? [tab] : [];
  });
  let list: HTMLDivElement | undefined;
  function revealActive() {
    if (!list?.isConnected) return;
    const selected = document.getElementById(`tab-${props.group.activeTab}`)?.parentElement;
    if (!selected || !list.contains(selected)) return;
    const viewport = list.getBoundingClientRect(), tab = selected.getBoundingClientRect();
    if (tab.left < viewport.left) list.scrollLeft += tab.left - viewport.left;
    else if (tab.right > viewport.right) {
      list.scrollLeft += Math.min(tab.left - viewport.left, tab.right - viewport.right);
    }
  }
  createEffect(() => {
    void props.group.activeTab;
    tabs();
    queueMicrotask(revealActive);
  });
  onMount(() => {
    const observer = new ResizeObserver(revealActive);
    observer.observe(list!);
    onCleanup(() => observer.disconnect());
  });
  function close(id: string) {
    w.close(id);
    queueMicrotask(() => {
      const next = props.group.activeTab;
      document.getElementById(next ? `tab-${next}` : props.group.id)?.focus();
    });
  }
  return (
    <div class="editor-tabs">
      <div ref={(element) => { list = element; }} class="tab-list" role="tablist" aria-label={`${props.label} open views`}>
        <For each={tabs()}>
          {(tab) => {
            const doc = () => w.state.documents.find((d) => d.id === tab.documentId);
            const title = () => {
              switch (tab.type) {
                case "graph": return "Knowledge graph";
                case "settings": return "Settings";
                case "custom":
                  w.contributionRevision();
                  return w.application.views().find((view) => `view:${view.id}` === tab.id)?.title ?? "Module view";
                case "document": return filename(doc()?.path ?? "");
              }
            };
            return (
              <div class="tab-wrapper" classList={{ active: props.group.activeTab === tab.id }}>
                <button
                  id={`tab-${tab.id}`}
                  role="tab"
                  title={doc()?.path ?? title()}
                  aria-label={title()}
                  aria-selected={props.group.activeTab === tab.id}
                  aria-controls={`surface-${tab.id}`}
                  tabindex={props.group.activeTab === tab.id ? 0 : -1}
                  class="editor-tab"
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer?.setData(EDITOR_TAB_DRAG, tab.id);
                    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
                  }}
                  onClick={() => w.activate(tab.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Delete") {
                      event.preventDefault();
                      close(tab.id);
                      return;
                    }
                    const items = tabs(), index = items.findIndex((item) => item.id === tab.id);
                    let next = index;
                    if (event.key === "ArrowRight") next = (index + 1) % items.length;
                    else if (event.key === "ArrowLeft") next = (index - 1 + items.length) % items.length;
                    else if (event.key === "Home") next = 0;
                    else if (event.key === "End") next = items.length - 1;
                    else return;
                    event.preventDefault();
                    w.activate(items[next].id);
                    document.getElementById(`tab-${items[next].id}`)?.focus();
                  }}
                >
                  <Icon name={tab.type === "graph" ? "graph" : tab.type === "settings"
                    ? "settings" : doc()?.kind === "note" ? "notes" : "code"} />
                  <span>{title()}</span>
                  <Show when={doc() && doc()?.content !== doc()?.savedContent}>
                    <span class="dirty-dot" aria-label="Modified draft" />
                  </Show>
                </button>
                <button class="tab-close" aria-label={`Close ${title()}`}
                  title="Close view (draft retained)" onClick={() => close(tab.id)}>
                  <Icon name="close" />
                </button>
              </div>
            );
          }}
        </For>
      </div>
      <IconButton name="plus" label={w.state.mode === "knowledge" ? "Create new note" : "Create new code file"} onClick={() => {
        w.focusGroup(props.group.id);
        props.onCreate();
      }} />
    </div>
  );
}
