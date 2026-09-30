import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Icon, IconButton } from "../components/Icon";
import { ResizeHandle } from "../components/ResizeHandle";
import type { Json } from "../../../modules-sdk/js/mod.ts";
import type { ThemeDefinition } from "../themes/registry";
import { MAX_EDITOR_GROUPS, type EditorGroup, type ViewTab } from "../workspace/model";
import type { Workspace } from "../workspace/store";
import { EDITOR_TAB_DRAG, EditorTabs } from "./EditorTabs";
import { EditorSurface } from "./EditorSurface";
import { Graph } from "./Graph";
import { ModuleViews } from "./ModuleViews";
import { Settings } from "./Settings";
import "./EditorGroups.css";

type Props = {
  workspace: Workspace;
  themes: readonly ThemeDefinition[];
  onCreate(): void;
  showPalette(): void;
  setCursor(value: string): void;
  execute(command: string, input: Json): void;
};

export function EditorGroups(props: Props) {
  // Workspace replacement releases old engine leases even when paths/groups coincide.
  return <Show when={props.workspace.viewEpoch()} keyed>{(_epoch) => <GroupLayout {...props} />}</Show>;
}

function GroupLayout(props: Props) {
  const w = props.workspace;
  const [slots, setSlots] = createSignal(new Map<string, HTMLDivElement>());
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  let root!: HTMLDivElement;
  const stacked = () => size().width < 640;
  const extent = () => Math.max(1, stacked() ? size().height : size().width);
  const total = () => w.state.groups.reduce((sum, group) => sum + group.size, 0);
  onMount(() => {
    const observer = new ResizeObserver(([entry]) => setSize({
      width: entry.contentRect.width, height: entry.contentRect.height,
    }));
    observer.observe(root);
    onCleanup(() => observer.disconnect());
  });
  function focus(id: string) {
    w.focusGroup(id);
    queueMicrotask(() => document.getElementById(id)?.focus());
  }
  function pane(group: EditorGroup, index: () => number) {
    onCleanup(() => setSlots((previous) => {
      const next = new Map(previous);
      next.delete(group.id);
      return next;
    }));
    const label = () => `Group ${index() + 1}`;
    return (
      <section
        class="editor-group"
        classList={{ "active-group": w.state.activeGroup === group.id }}
        aria-label={label()}
        style={{ "flex-grow": group.size }}
        onFocusIn={() => w.focusGroup(group.id)}
        onPointerDown={() => w.focusGroup(group.id)}
        onDragOver={(event) => {
          if (event.dataTransfer?.types.includes(EDITOR_TAB_DRAG)) event.preventDefault();
        }}
        onDrop={(event) => {
          const tab = event.dataTransfer?.getData(EDITOR_TAB_DRAG);
          if (!tab) return;
          event.preventDefault();
          w.moveTab(tab, group.id);
        }}
      >
        <div class="editor-group-heading">
          <button id={group.id} class="group-focus" aria-pressed={w.state.activeGroup === group.id}
            onClick={() => focus(group.id)}>{label()}</button>
          <div class="editor-group-actions">
            <Show when={w.state.groups.length > 1}>
              <select
                class="group-move"
                aria-label={`Move active tab from ${label()}`}
                disabled={!group.activeTab}
                value=""
                onChange={(event) => {
                  const destination = event.currentTarget.value;
                  if (destination && group.activeTab) w.moveTab(group.activeTab, destination);
                  event.currentTarget.value = "";
                }}
              >
                <option value="">Move tab...</option>
                <For each={w.state.groups}>{(destination, destinationIndex) =>
                  <Show when={destination.id !== group.id}>
                    <option value={destination.id}>Group {destinationIndex() + 1}</option>
                  </Show>}
                </For>
              </select>
            </Show>
            <IconButton name="right" label={`Split ${label()} (Ctrl+\\)`}
              disabled={w.state.groups.length >= MAX_EDITOR_GROUPS}
              onClick={() => { w.splitGroup(group.id); focus(w.state.activeGroup); }} />
            <IconButton name="close" label={`Close ${label()} (keep tabs)`}
              disabled={w.state.groups.length === 1}
              onClick={() => { w.closeGroup(group.id); focus(w.state.activeGroup); }} />
          </div>
        </div>
        <EditorTabs workspace={w} group={group} label={label()} onCreate={props.onCreate} />
        <div class="editor-content" ref={(element) => setSlots((previous) =>
          new Map(previous).set(group.id, element))}>
          <Show when={!group.tabs.length}>
            <div class="empty-editor">
              <div class="empty-monogram">M</div>
              <h1>Room for your next idea.</h1>
              <p>Open a file, create a {w.state.mode === "knowledge" ? "note" : "code file"}, or move a tab here.</p>
              <button class="primary-button" onClick={() => {
                w.focusGroup(group.id); props.onCreate();
              }}><Icon name="plus" />{w.state.mode === "knowledge" ? "New note" : "New code file"}</button>
              <button class="text-button" onClick={props.showPalette}>Find a file or command <kbd>Ctrl K</kbd></button>
            </div>
          </Show>
        </div>
        <Show when={index() < w.state.groups.length - 1}>
          <ResizeHandle label={`Resize ${label()}`} orientation={stacked() ? "horizontal" : "vertical"}
            value={group.size / total() * extent()} min={32}
            max={(group.size + w.state.groups[index() + 1].size) / total() * extent() - 32}
            onChange={(pixels) => w.resizeGroup(group.id, pixels / extent() * total())} />
        </Show>
      </section>
    );
  }
  return (
    <div ref={(element) => { root = element; }} class="editor-groups" classList={{ stacked: stacked() }}>
      <For each={w.state.groups}>{pane}</For>
      <For each={w.state.tabs}>{(tab) => <GroupView {...props} tab={tab}
        slot={() => {
          const group = w.state.groups.find((group) => group.tabs.includes(tab.id));
          return group ? slots().get(group.id) : undefined;
        }} />}</For>
    </div>
  );
}

/** Move the stable portal host, not the editor component or its model lease. */
function GroupView(props: Props & { tab: ViewTab; slot(): HTMLElement | undefined }) {
  const w = props.workspace, tab = props.tab;
  const host = document.createElement("div");
  host.className = "editor-view-host";
  const active = () => w.state.groups.some((group) => group.activeTab === tab.id);
  createEffect(() => {
    const slot = props.slot();
    if (slot && host.parentElement !== slot) slot.append(host);
  });
  createEffect(() => { host.hidden = !active(); });
  onCleanup(() => host.remove());
  return (
    <Portal mount={host}>
      <section class="tab-surface" role="tabpanel" id={`surface-${tab.id}`}
        aria-labelledby={`tab-${tab.id}`} hidden={!active()}
        onFocusIn={() => { if (w.state.activeTab !== tab.id) w.activate(tab.id); }}
        onPointerDown={() => { if (w.state.activeTab !== tab.id) w.activate(tab.id); }}>
        <Show when={tab.type === "settings"}><Settings workspace={w} themes={props.themes} /></Show>
        <Show when={tab.type === "custom"}>
          <ModuleViews workspace={w} location="editor" id={tab.id} execute={props.execute} />
        </Show>
        <Show when={tab.type === "graph"}><Graph workspace={w} /></Show>
        <Show when={tab.type === "document" && tab.documentId} keyed>
          {(id) => {
            const doc = () => w.state.documents.find((doc) => doc.id === id);
            return <Show when={doc()}>{(document) =>
              <EditorSurface document={document()} tab={tab} active={active()}
                focused={w.state.activeTab === tab.id} workspace={w} setCursor={props.setCursor} />}
            </Show>;
          }}
        </Show>
      </section>
    </Portal>
  );
}
