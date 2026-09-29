import { createEffect, createSignal, For, Show } from "solid-js";
import type { ViewTab, WorkspaceDocument } from "../workspace/model";
import type { Workspace } from "../workspace/store";
import { Icon, IconButton } from "../components/Icon";
import { EngineSurface } from "../editors/EngineSurface";
import { Markdown } from "./Markdown";
import { AttachmentButton } from "./AttachmentButton";
import { openCodeSymbol } from "../workspace/code_links";

export function EditorSurface(
  props: {
    document: WorkspaceDocument;
    workspace: Workspace;
    setCursor: (value: string) => void;
    active: boolean;
    focused: boolean;
    tab: ViewTab;
  },
) {
  const preview = () => props.tab.view?.preview ??
    (props.workspace.preferences.effective().noteView === "read" &&
      !/(^|\/)Untitled \d+\.md$/.test(props.document.path));
  const setPreview = (preview: boolean) => props.workspace.viewState(props.tab.id, { preview });
  const [loaded, setLoaded] = createSignal(false);
  createEffect(() => {
    if (props.active && (props.document.kind !== "note" || !preview())) {
      setLoaded(true);
    }
  });
  createEffect(() => {
    const selection = props.workspace.requestedSelection();
    if (selection?.id === props.document.id && selection.viewId === props.tab.id) setPreview(false);
  });
  function download() {
    const url = URL.createObjectURL(
      new Blob([props.document.content], { type: "text/plain;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = props.document.path.split("/").at(-1)!;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    props.workspace.notify(`Downloaded ${anchor.download}`);
  }
  return (
    <>
      <div class="document-toolbar">
        <div class="breadcrumbs">
          <Icon name={props.document.kind === "note" ? "notes" : "code"} />
          <For each={props.document.path.split("/")}>
            {(part, i) => (
              <>
                <Show when={i() > 0}>
                  <Icon name="chevron" />
                </Show>
                <span>{part}</span>
              </>
            )}
          </For>
        </div>
        <div class="document-actions">
          <Show when={props.document.kind === "note"}>
            <AttachmentButton workspace={props.workspace} document={props.document} atEnd={preview()} />
            <div class="view-switch" aria-label="Note view">
              <button
                classList={{ active: !preview() }}
                aria-pressed={!preview()}
                onClick={() => {
                  setPreview(false);
                }}
              >
                Edit
              </button>
              <button
                classList={{ active: preview() }}
                aria-pressed={preview()}
                onClick={() => setPreview(true)}
              >
                Read
              </button>
            </div>
          </Show>
          <IconButton
            name="save"
            label={props.workspace.diskDocuments().includes(
                props.document.id,
              ) || props.workspace.workspaceInfo()
              ? "Save to disk (Ctrl+S)"
              : "Save draft in browser (Ctrl+S)"}
            onClick={() => props.workspace.save(props.document.id)}
          />
          <IconButton
            name="download"
            label="Download this file"
            onClick={download}
          />
        </div>
      </div>
      <Show when={props.workspace.diskErrors()[props.document.id]}>
        <div class="document-warning" role="alert">
          <span>{props.workspace.diskErrors()[props.document.id]}</span>
          <button
            onClick={() => void props.workspace.reloadFile(props.document.id)}
          >
            Reload from disk
          </button>
          <button onClick={download}>Download draft</button>
        </div>
      </Show>
      <div
        class="engine-container"
        hidden={props.document.kind === "note" && preview()}
      >
        <Show when={loaded()}>
          <EngineSurface
            document={props.document}
            workspace={props.workspace}
            tab={props.tab}
            focused={props.focused}
            visible={props.active &&
              (props.document.kind !== "note" || !preview())}
            setCursor={props.setCursor}
          />
        </Show>
      </div>
      <Show when={props.document.kind === "note" && props.active && preview()}>
        <div
          class="reading-surface"
          ref={(element) => queueMicrotask(() => {
            if (element.isConnected) element.scrollTop = props.tab.view?.readingScroll ?? 0;
          })}
          onScroll={(event) => props.workspace.viewState(props.tab.id, {
            readingScroll: event.currentTarget.scrollTop,
          })}
        >
          <div class="document-eyebrow">
            <span>WORKSPACE NOTES</span>
            <span>
              {Math.max(
                1,
                Math.ceil(props.document.content.split(/\s+/).length / 200),
              )} min read
            </span>
          </div>
          <Markdown
            document={props.document}
            documents={props.workspace.knowledge.notes()}
            open={(id) => void props.workspace.openFile(id)}
            openFile={props.workspace.openFile}
            request={props.workspace.request}
            openSymbol={(path, fragment) => openCodeSymbol(props.workspace, path, fragment)}
            notify={props.workspace.notify}
          />
          <div class="document-end">
            <span />End of note<span />
          </div>
        </div>
      </Show>
    </>
  );
}
