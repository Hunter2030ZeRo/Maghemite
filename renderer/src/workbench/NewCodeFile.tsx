import { createSignal, onMount, Show } from "solid-js";
import type { Workspace } from "../workspace/store";

export function NewCodeFile(props: { workspace: Workspace; close: () => void }) {
  const [path, setPath] = createSignal("");
  const [error, setError] = createSignal("");
  const [dialog, setDialog] = createSignal<HTMLDialogElement>();
  onMount(() => {
    let number = 1;
    while (props.workspace.state.documents.some((doc) => doc.path === `Untitled ${number}.ts`)) {
      number++;
    }
    setPath(`Untitled ${number}.ts`);
    dialog()?.showModal();
  });
  function create(event: SubmitEvent) {
    event.preventDefault();
    try {
      props.workspace.newCode(path());
      props.close();
    } catch (cause) {
      setError(String(cause));
    }
  }
  return (
    <dialog ref={(element) => setDialog(element)} class="new-code-dialog" onClose={props.close}>
      <form onSubmit={create}>
        <h2>New code file</h2>
        <label for="new-code-path">File path</label>
        <input
          id="new-code-path"
          autofocus
          required
          value={path()}
          onInput={(event) => {
            setPath(event.currentTarget.value);
            setError("");
          }}
        />
        <p>Enter a workspace-relative path and filename, such as src/main.py.</p>
        <Show when={error()}><p role="alert" class="new-code-error">{error()}</p></Show>
        <div class="new-code-actions">
          <button type="button" class="secondary-button" onClick={props.close}>Cancel</button>
          <button type="submit" class="primary-button">Create file</button>
        </div>
      </form>
    </dialog>
  );
}
