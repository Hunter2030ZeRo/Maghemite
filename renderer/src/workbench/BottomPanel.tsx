import { ModuleViews } from "./ModuleViews";
import { createEffect, lazy } from "solid-js";
const TerminalPanel = lazy(() =>
  import("./TerminalPanel").then((m) => ({ default: m.TerminalPanel }))
);
import type { TerminalAction } from "./TerminalPanel";
import type { Json } from "../../../modules-sdk/js/mod.ts";
import { createSignal, For, Show } from "solid-js";
import { Icon, IconButton } from "../components/Icon";
import { ResizeHandle } from "../components/ResizeHandle";
import type { Workspace } from "../workspace/store";

export function BottomPanel(
  props: {
    workspace: Workspace;
    terminal?: (action: string, p: Json) => Promise<Json>;
    execute?: (command: string, input: Json) => void;
    terminalConnected: boolean;
    terminalAction: TerminalAction;
  },
) {
  const w = props.workspace;
  const [panel, setPanel] = createSignal<string>(
    "terminal",
  );
  const [terminalVisited, setTerminalVisited] = createSignal(false);
  createEffect(() => {
    if (w.state.layout.bottom && panel() === "terminal") {
      setTerminalVisited(true);
    }
  });
  createEffect(() => {
    if (props.terminalAction.id) setPanel("terminal");
  });
  return (
    <section
      class="bottom-panel"
      style={{
        height: `${w.state.layout.bottomHeight}px`,
        display: w.state.layout.bottom ? "flex" : "none",
      }}
      aria-label="Bottom panel"
    >
      <ResizeHandle
        label="Resize bottom panel"
        orientation="horizontal"
        reverse
        value={w.state.layout.bottomHeight}
        min={120}
        max={400}
        onChange={(bottomHeight) => w.layout({ bottomHeight })}
      />
      <div class="bottom-panel-header">
        <div role="tablist" aria-label="Tool panels">
          <For each={["terminal", "output", "problems"] as const}>
            {(name) => (
              <button
                role="tab"
                aria-selected={panel() === name}
                aria-controls={`tool-${name}`}
                id={`tool-tab-${name}`}
                onClick={() => setPanel(name)}
              >
                {name[0].toUpperCase() + name.slice(1)}
              </button>
            )}
          </For>
          <For
            each={(w.contributionRevision(),
              w.application.views().filter((v) => v.location === "bottom"))}
          >
            {(view) => (
              <button
                role="tab"
                aria-selected={panel() === `view:${view.id}`}
                id={`tool-tab-view:${view.id}`}
                aria-controls={`tool-view:${view.id}`}
                onClick={() => setPanel(`view:${view.id}`)}
              >
                {view.title}
              </button>
            )}
          </For>
        </div>
        <IconButton
          name="close"
          label="Close bottom panel"
          onClick={() => w.layout({ bottom: false })}
        />
      </div>
      <div
        class="bottom-panel-body"
        role="tabpanel"
        id={`tool-${panel()}`}
        aria-labelledby={`tool-tab-${panel()}`}
      >
        <Show when={panel() === "output"}>
          <div class="output-label">WORKSPACE SESSION</div>
          <For each={w.events()}>
            {(event) => (
              <div class="output-line">
                <Icon name="chevron" />
                <span>{event}</span>
              </div>
            )}
          </For>
        </Show>
        <div class="terminal-panel-content" hidden={panel() !== "terminal"}>
          <Show when={terminalVisited()}>
            <Show
              when={props.terminal}
              fallback={<p>Desktop terminal connection unavailable.</p>}
            >
              <TerminalPanel
                request={props.terminal!}
                active={w.state.layout.bottom && panel() === "terminal"}
                connected={props.terminalConnected}
                workspaceId={w.workspaceInfo()?.id}
                action={props.terminalAction}
              />
            </Show>
          </Show>
        </div>
        <Show when={panel() === "problems"}>
          <For
            each={(w.contributionRevision(), w.application.diagnostics())}
            fallback={<p>No diagnostics for the current document versions.</p>}
          >
            {(collection) => (
              <For each={collection.items}>
                {(item) => (
                  <button
                    class="problem-row"
                    onClick={() => {
                      w.open(collection.documentId);
                      const doc = w.state.documents.find((d) =>
                        d.id === collection.documentId
                      )!;
                      const offset = Math.min(
                        doc.content.length,
                        doc.content.split("\n").slice(0, item.line - 1)
                          .reduce((n, l) => n + l.length + 1, 0) +
                          item.column,
                      );
                      try {
                        w.application.invoke("editor.setSelection", {
                          id: doc.id,
                          version: collection.version,
                          anchor: offset,
                          head: offset,
                        }, "maghemite.workbench");
                      } catch (e) {
                        w.notify(String(e));
                      }
                    }}
                  >
                    {item.severity} · {collection.documentId}:{item.line} —{" "}
                    {item.message}
                  </button>
                )}
              </For>
            )}
          </For>
        </Show>
        <Show when={panel().startsWith("view:")}>
          <ModuleViews
            workspace={w}
            location="bottom"
            id={panel()}
            execute={(...args) => props.execute?.(...args)}
          />
        </Show>
      </div>
    </section>
  );
}
