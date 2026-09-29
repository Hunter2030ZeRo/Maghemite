import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { Json } from "../../../modules-sdk/js/mod.ts";
import { Icon } from "../components/Icon";

export function OpenFolder(props: {
  current?: string;
  connected: boolean;
  request: (method: string, parameters?: Json) => Promise<Json>;
  close: () => void;
  opened: (changed: boolean, warning?: string | null) => void;
}) {
  let dialog!: HTMLDialogElement;
  let input!: HTMLInputElement;
  const previous = document.activeElement;
  const [path, setPath] = createSignal(props.current ?? "");
  const [recent, setRecent] = createSignal<string[]>([]);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal<"browse" | "open" | null>(null);
  let disposed = false;
  onMount(() => {
    dialog.showModal();
    input.focus();
    input.select();
    if (props.connected) {
      void props.request("workspace.recent").then((value) => {
        if (!disposed) setRecent((value as { paths: string[] }).paths);
      }).catch((error) => {
        if (!disposed) {
          setError(String(error));
        }
      });
    }
  });
  onCleanup(() => {
    disposed = true;
    dialog.close();
    if (previous instanceof HTMLElement && previous.isConnected) {
      previous.focus();
    }
  });
  async function browse() {
    setError("");
    setBusy("browse");
    try {
      const result = await props.request("workspace.browse") as {
        path: string | null;
      };
      if (result.path) setPath(result.path);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(null);
      input.focus();
    }
  }
  async function open(event: SubmitEvent) {
    event.preventDefault();
    if (busy() || !props.connected || !path()) return;
    setError("");
    setBusy("open");
    try {
      const result = await props.request("workspace.open", {
        path: path(),
      }) as { changed: boolean; warning: string | null };
      props.opened(result.changed, result.warning);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(null);
    }
  }
  return (
    <dialog
      ref={dialog}
      class="folder-dialog"
      aria-labelledby="folder-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy()) props.close();
      }}
    >
      <form onSubmit={open}>
        <header>
          <Icon name="folder" />
          <h2 id="folder-dialog-title">Open folder</h2>
        </header>
        <p>Choose a project or notebook to use as your workspace.</p>
        <label for="workspace-folder-path">Folder path</label>
        <div class="folder-path-row">
          <input
            ref={input}
            id="workspace-folder-path"
            value={path()}
            placeholder="/home/you/projects/my-project"
            autocomplete="off"
            spellcheck={false}
            disabled={!!busy()}
            onInput={(e) => setPath(e.currentTarget.value)}
          />
          <button
            type="button"
            class="secondary-button"
            disabled={!!busy() || !props.connected}
            onClick={() => void browse()}
          >
            {busy() === "browse" ? "Choosing…" : "Browse…"}
          </button>
        </div>
        <Show when={recent().length}>
          <h3>Recent folders</h3>
          <div class="recent-folders">
            <For each={recent()}>
              {(folder) => (
                <button
                  type="button"
                  disabled={!!busy()}
                  title={folder}
                  classList={{ selected: path() === folder }}
                  onClick={() => {
                    setPath(folder);
                    input.focus();
                  }}
                >
                  <Icon name="folder" />
                  <span>{folder}</span>
                  <Show when={folder === props.current}>
                    <small>Current</small>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
        <p class="folder-draft-hint">
          Tabs and unsaved drafts are kept separately for each folder. Switching
          closes running terminals and tools.
        </p>
        <Show when={!props.connected}>
          <p role="status">Connect to the desktop host to open a folder.</p>
        </Show>
        <Show when={error()}>
          <p class="folder-error" role="alert">{error()}</p>
        </Show>
        <footer>
          <button
            type="button"
            class="secondary-button"
            disabled={!!busy()}
            onClick={props.close}
          >
            Cancel
          </button>
          <button
            type="submit"
            class="primary-button"
            disabled={!!busy() || !props.connected || !path()}
          >
            {busy() === "open" ? "Opening…" : "Open folder"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
