import { createSignal, Show } from "solid-js";
import type { TrashEntry } from "../../../modules-sdk/js/file_operations.ts";
import { Icon } from "../components/Icon";

export type WorkspaceFiles = {
  readonly busy: () => boolean;
  readonly revision: () => number;
  readonly move: (path: string, to: string, updateLinks: boolean) => Promise<void>;
  readonly trash: (path: string) => Promise<void>;
  readonly restore: (id: string, to?: string) => Promise<void>;
  readonly trashList: (offset?: number) => Promise<{
    readonly entries: readonly TrashEntry[];
    readonly nextOffset: number | null;
  }>;
};

type Action = "menu" | "move" | "trash" | null;

type FileActionsProps = {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly files: WorkspaceFiles;
  readonly connected: boolean;
};

export function FileActions(props: FileActionsProps) {
  const [action, setAction] = createSignal<Action>(null);
  const [destination, setDestination] = createSignal(props.path);
  const [updateLinks, setUpdateLinks] = createSignal(true);
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal("");
  let actionTrigger: HTMLButtonElement | undefined;

  function close() {
    setAction(null);
    setError("");
  }

  async function move(event: SubmitEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      await props.files.move(props.path, destination().trim(), updateLinks());
      close();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  }

  async function trash() {
    setPending(true);
    setError("");
    try {
      await props.files.trash(props.path);
      close();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  }

  const disabled = () => !props.connected || pending() || props.files.busy();

  return (
    <div
      class="file-actions"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        close();
        actionTrigger?.focus();
      }}
    >
      <div class="file-actions-menu">
        <button
          ref={(element) => {
            actionTrigger = element;
          }}
          type="button"
          class="icon-button file-actions-trigger"
          aria-label={`Actions for ${props.path}`}
          title={`Actions for ${props.path}`}
          aria-expanded={action() !== null}
          disabled={!props.connected}
          onClick={() => {
            if (action()) close();
            else setAction("menu");
          }}
        >
          <Icon name="dots" />
        </button>
        <Show when={action() === "menu"}>
          <div
            class="file-action-choices"
            role="group"
            aria-label={`Actions for ${props.path}`}
          >
            <button
              type="button"
              class="text-button"
              disabled={disabled()}
              onClick={() => {
                setDestination(props.path);
                setUpdateLinks(true);
                setError("");
                setAction("move");
              }}
            >
              Rename / move…
            </button>
            <button
              type="button"
              class="text-button"
              disabled={disabled()}
              onClick={() => {
                setError("");
                setAction("trash");
              }}
            >
              Move to Trash…
            </button>
          </div>
        </Show>
        <Show when={action() === "move"}>
          <form class="file-operation-form" onSubmit={move}>
            <div class="file-operation-heading">
              <strong>Rename or move</strong>
              <button
                type="button"
                class="text-button"
                onClick={close}
                disabled={pending()}
              >
                Close
              </button>
            </div>
            <p class="file-operation-kind">
              {props.kind === "directory" ? "Folder" : "File"}
            </p>
            <dl class="file-path-pair">
              <div>
                <dt>From</dt>
                <dd title={props.path}>{props.path}</dd>
              </div>
              <div>
                <dt>
                  <label for={`file-destination-${props.path}`}>
                    Destination
                  </label>
                </dt>
                <dd>
                  <input
                    id={`file-destination-${props.path}`}
                    required
                    autofocus
                    value={destination()}
                    disabled={pending()}
                    aria-describedby={`file-destination-help-${props.path}`}
                    onInput={(event) => setDestination(event.currentTarget.value)}
                  />
                </dd>
              </div>
            </dl>
            <p
              class="file-operation-help"
              id={`file-destination-help-${props.path}`}
            >
              Change the final name to rename, or edit the folders to move.
            </p>
            <label class="file-operation-checkbox">
              <input
                type="checkbox"
                checked={updateLinks()}
                disabled={pending()}
                onChange={(event) => setUpdateLinks(event.currentTarget.checked)}
              />
              Update note links
            </label>
            <div class="file-operation-buttons">
              <button
                type="submit"
                class="text-button"
                disabled={disabled() ||
                  destination().trim() === props.path ||
                  !destination().trim()}
              >
                {pending() ? "Moving…" : "Rename / move"}
              </button>
              <button
                type="button"
                class="text-button"
                disabled={pending()}
                onClick={() => {
                  setAction("trash");
                  setError("");
                }}
              >
                Move to Trash…
              </button>
              <button
                type="button"
                class="text-button"
                disabled={pending()}
                onClick={close}
              >
                Cancel
              </button>
            </div>
            <Show when={error()}>
              <p class="file-operation-error" role="alert">{error()}</p>
            </Show>
          </form>
        </Show>
        <Show when={action() === "trash"}>
          <section
            class="file-operation-form file-trash-confirmation"
            aria-label={`Move ${props.path} to Trash`}
          >
            <strong>Move to Trash?</strong>
            <p class="file-operation-path" title={props.path}>
              {props.path}
            </p>
            <p>
              This item can be restored from Trash. Unsaved drafts are retained
              separately and remain recoverable.
            </p>
            <div class="file-operation-buttons">
              <button
                type="button"
                class="text-button"
                disabled={disabled()}
                onClick={() => void trash()}
              >
                {pending() ? "Moving to Trash…" : "Move to Trash"}
              </button>
              <button
                type="button"
                class="text-button"
                disabled={pending()}
                onClick={close}
              >
                Cancel
              </button>
            </div>
            <Show when={error()}>
              <p class="file-operation-error" role="alert">{error()}</p>
            </Show>
          </section>
        </Show>
      </div>
    </div>
  );
}
