import { ModuleManager } from "./ModuleManager";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { Workspace } from "../workspace/store";
import { filename, stem, type WorkspaceDocument } from "../workspace/model";
import { DiskExplorer } from "./DiskExplorer";
import { SearchPanel } from "./SearchPanel";
import { Icon, IconButton } from "../components/Icon";

export function Sidebar(
  props: {
    workspace: Workspace;
    modulesConnected?: boolean;
    moduleCommandCount?: number;
    openFolder: () => void;
    pickFiles: () => void;
    openDocument: (id: string, line?: number) => void;
    newNote: () => void;
  },
) {
  const w = props.workspace;
  const [collapsed, setCollapsed] = createSignal<string[]>([]);
  const folders = createMemo(() =>
    [
      ...new Set(w.state.documents.map((d) =>
        d.path.includes("/") ? d.path.slice(0, d.path.lastIndexOf("/")) : ""
      )),
    ].sort()
  );
  function file(doc: WorkspaceDocument, indented = false) {
    return (
      <button
        class={`file-row ${indented ? "indented" : ""}`}
        classList={{ selected: w.activeDocument()?.id === doc.id }}
        onClick={() => props.openDocument(doc.id)}
        aria-label={filename(doc.path)}
        aria-description={doc.content !== doc.savedContent
          ? "Modified draft"
          : undefined}
        title={doc.path}
      >
        <span class={`file-type ${doc.kind}`}>
          <Icon name={doc.kind === "note" ? "notes" : "code"} />
        </span>
        <span class="truncate">{filename(doc.path)}</span>
        <Show when={doc.content !== doc.savedContent}>
          <span class="dirty-dot" title="Modified draft" />
        </Show>
      </button>
    );
  }
  return (
    <aside class="primary-sidebar" aria-label="Primary sidebar">
      <div class="panel-heading">
        <span>
          {{
            files: "Explorer",
            search: "Search",
            notes: "Notes",
            modules: "Modules",
          }[w.activity()]}
        </span>
        <div class="heading-actions">
          <IconButton name="plus" label="New note" onClick={props.newNote} />
          <IconButton
            name="folder"
            label="Open folder"
            onClick={props.openFolder}
          />
          <IconButton
            name="files"
            label="Import text files"
            onClick={props.pickFiles}
          />
        </div>
      </div>
      <div class="sidebar-body">
        <Show when={w.activity() === "files"}>
          <div class="workspace-name">
            <span class="workspace-mark">M</span>
            <div>
              <strong>{w.workspaceInfo()?.label ?? "Maghemite"}</strong>
              <small title={w.workspaceInfo()?.path}>
                {w.workspaceInfo() ? "Workspace" : "Sample workspace"}
              </small>
            </div>
          </div>
          <Show
            when={w.workspaceInfo()}
            fallback={
              <>
                <button class="graph-shortcut" onClick={props.openFolder}>
                  <Icon name="folder" />Open folder…<Icon name="arrow" />
                </button>
                <div class="section-label">
                  FILES <span>{w.state.documents.length}</span>
                </div>
                <For each={folders()}>
                  {(folder) => (
                    <div>
                      <Show when={folder}>
                        <button
                          class="folder-row"
                          aria-expanded={!collapsed().includes(folder)}
                          onClick={() =>
                            setCollapsed((list) =>
                              list.includes(folder)
                                ? list.filter((f) => f !== folder)
                                : [...list, folder]
                            )}
                        >
                          <Icon
                            name="chevron"
                            class={collapsed().includes(folder)
                              ? ""
                              : "expanded"}
                          />
                          <Icon name="folder" />
                          <span>{folder}</span>
                        </button>
                      </Show>
                      <Show when={!folder || !collapsed().includes(folder)}>
                        <For
                          each={w.state.documents.filter((d) =>
                            (d.path.includes("/")
                              ? d.path.slice(0, d.path.lastIndexOf("/"))
                              : "") === folder
                          )}
                        >
                          {(doc) => file(doc, !!folder)}
                        </For>
                      </Show>
                    </div>
                  )}
                </For>
              </>
            }
          >
            <DiskExplorer workspace={w} />
          </Show>
        </Show>
        <Show when={w.activity() === "notes"}>
          <div class="section-intro">
            <h2>Your notebook</h2>
            <p>Follow an idea. Leave a connection.</p>
          </div>
          <button class="graph-shortcut" onClick={() => w.openGraph()}>
            <Icon name="graph" />Open knowledge graph<Icon name="arrow" />
          </button>
          <div class="section-label">
            ALL NOTES{" "}
            <span>
              {w.state.documents.filter((d) => d.kind === "note").length}
            </span>
          </div>
          <For each={w.state.documents.filter((d) => d.kind === "note")}>
            {(doc) => (
              <button
                class="note-row"
                classList={{ selected: w.activeDocument()?.id === doc.id }}
                onClick={() => props.openDocument(doc.id)}
              >
                <Icon name="notes" />
                <div>
                  <strong>{stem(doc.path)}</strong>
                  <small>{doc.path}</small>
                </div>
                <Show when={doc.content !== doc.savedContent}>
                  <span class="dirty-dot" />
                </Show>
              </button>
            )}
          </For>
        </Show>
        <div hidden={w.activity() !== "search"}>
          <SearchPanel workspace={w} openDocument={props.openDocument} />
        </div>
        <Show when={w.activity() === "modules"}>
          <Show
            when={props.modulesConnected}
            fallback={
              <p class="empty-copy">
                Connect to the desktop to manage modules.
              </p>
            }
          >
            <ModuleManager workspace={w} />
          </Show>
        </Show>
      </div>
      <div class="sidebar-footer">
        <span class="sample-dot" />
        {w.workspaceInfo() ? "Workspace" : "Local preview"}
        <span>
          {w.workspaceInfo()
            ? (w.diskConnected() ? "Disk connected" : "Disconnected")
            : "Browser drafts"}
        </span>
      </div>
    </aside>
  );
}
