import { For, Show } from "solid-js";
import type { Workspace } from "../workspace/store";
import type { Json } from "../../../modules-sdk/js/mod.ts";
export function ModuleViews(
  props: {
    workspace: Workspace;
    location: string;
    id?: string;
    execute: (command: string, input: Json) => void;
  },
) {
  const views = () => {
    props.workspace.contributionRevision();
    return props.workspace.application.views().filter((v) =>
      v.location === props.location &&
      (!props.id || `view:${v.id}` === props.id)
    );
  };
  return (
    <div class="module-views">
      <For each={views()}>
        {(view) => (
          <section class="module-view" aria-label={view.title}>
            <header>
              <strong>{view.title}</strong>
              <small>{view.moduleId}</small>
            </header>
            <For each={view.blocks}>
              {(block) => (
                <Show
                  when={block.kind === "button"}
                  fallback={block.kind === "code"
                    ? <pre>{block.text}</pre>
                    : <p>{block.text}</p>}
                >
                  <button
                    class="text-button"
                    onClick={() => {
                      props.workspace.application.action(
                        view.id,
                        block.input ?? null,
                      );
                      props.execute(block.command!, block.input ?? null);
                    }}
                  >
                    {block.text}
                  </button>
                </Show>
              )}
            </For>
          </section>
        )}
      </For>
    </div>
  );
}
