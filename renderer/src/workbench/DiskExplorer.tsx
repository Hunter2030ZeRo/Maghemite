import { createMemo, createSignal, Show } from "solid-js";
import type { Workspace } from "../workspace/store";
import { IconButton } from "../components/Icon";
import { DiskDirectory } from "./DiskDirectory";
import { TrashPanel } from "./TrashPanel";
import "./FileOperations.css";

export function DiskExplorer(props: { workspace: Workspace }) {
  const w = props.workspace;
  const [revision, setRevision] = createSignal(0);
  const [expanded, setExpanded] = createSignal<readonly string[]>([]);
  const [showTrash, setShowTrash] = createSignal(false);
  const [creating, setCreating] = createSignal<"file" | "directory" | null>(
    null,
  );
  const [path, setPath] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  async function create(event: SubmitEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (creating() === "directory") {
        await w.request("files.mkdir", { path: path() });
      } else await w.createFile(path());
      setCreating(null);
      setPath("");
      setRevision((n) => n + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const treeRevision = createMemo(() =>
    `${revision()}:${w.files.revision()}:${w.workspaceInfo()?.id}`
  );
  return (
    <div class="disk-explorer">
      <div class="section-label">
        FILES{" "}
        <div class="heading-actions">
          <button
            type="button"
            class="text-button file-trash-entry"
            aria-pressed={showTrash()}
            disabled={!w.diskConnected()}
            onClick={() => {
              setShowTrash((open) => !open);
              setCreating(null);
              setError("");
            }}
          >
            Trash
          </button>
          <IconButton
            name="plus"
            label="New workspace file"
            disabled={!w.diskConnected() || w.files.busy()}
            onClick={() => {
              setShowTrash(false);
              setCreating("file");
              setError("");
            }}
          />
          <IconButton
            name="folder"
            label="New workspace folder"
            disabled={!w.diskConnected() || w.files.busy()}
            onClick={() => {
              setShowTrash(false);
              setCreating("directory");
              setError("");
            }}
          />
          <IconButton
            name="refresh"
            label="Refresh workspace files"
            disabled={!w.diskConnected() || w.files.busy()}
            onClick={() => {
              setRevision((n) => n + 1);
              void w.checkDiskFiles();
            }}
          />
        </div>
      </div>
      <Show
        when={w.diskConnected()}
        fallback={
          <p class="empty-copy">
            Desktop disconnected. Open drafts remain available.
          </p>
        }
      >
        <Show
          when={!showTrash()}
          fallback={
            <TrashPanel
              files={w.files}
              connected={w.diskConnected()}
              close={() => setShowTrash(false)}
            />
          }
        >
          <Show when={creating()}>
            <form
              class="new-path-form"
              onSubmit={create}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                setCreating(null);
                setError("");
              }}
            >
              <label for="new-workspace-path">
                {creating() === "file" ? "New file path" : "New folder path"}
              </label>
              <input
                id="new-workspace-path"
                required
                autofocus
                value={path()}
                disabled={busy() || w.files.busy()}
                placeholder={creating() === "file"
                  ? "notes/Idea.md"
                  : "notes"}
                onInput={(event) => setPath(event.currentTarget.value)}
              />
              <div>
                <button
                  type="submit"
                  class="text-button"
                  disabled={busy() || w.files.busy()}
                >
                  {busy() ? "Creating…" : "Create"}
                </button>
                <button
                  type="button"
                  class="text-button"
                  disabled={busy()}
                  onClick={() => {
                    setCreating(null);
                    setError("");
                  }}
                >
                  Cancel
                </button>
              </div>
              <Show when={error()}>
                <p role="alert">{error()}</p>
              </Show>
            </form>
          </Show>
          <DiskDirectory
            workspace={w}
            path=""
            depth={0}
            revision={treeRevision()}
            expanded={expanded}
            toggleExpanded={(entryPath) =>
              setExpanded((current) =>
                current.includes(entryPath)
                  ? current.filter((item) => item !== entryPath)
                  : [...current, entryPath]
              )}
          />
        </Show>
      </Show>
    </div>
  );
}
