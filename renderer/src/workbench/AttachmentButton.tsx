import { createSignal, onCleanup, Show } from "solid-js";
import { createAppAPI } from "../../../modules-sdk/js/app.ts";
import { createAttachments } from "../workspace/attachments";
import type { WorkspaceDocument } from "../workspace/model";
import type { Workspace } from "../workspace/store";
import { IconButton } from "../components/Icon";
import "./AttachmentButton.css";

export function AttachmentButton(props: {
  readonly workspace: Workspace;
  readonly document: WorkspaceDocument;
  readonly atEnd?: boolean;
}) {
  const w = props.workspace;
  const app = createAppAPI(async (method, parameters) => {
    switch (method) {
      case "editor.getSelection":
      case "documents.applyEdit":
      case "editor.setSelection":
        return w.application.invoke(method, parameters, "maghemite.workbench");
      default:
        throw new Error("Unsupported attachment editor operation");
    }
  });
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [uploadedLink, setUploadedLink] = createSignal("");
  let input: HTMLInputElement | undefined;
  let operation: AbortController | undefined;
  onCleanup(() => operation?.abort());

  async function attach(file: File) {
    const id = props.document.id, path = props.document.path;
    const append = props.atEnd;
    const content = props.document.content;
    operation = new AbortController();
    const signal = operation.signal;
    setBusy(true);
    setError("");
    setUploadedLink("");
    try {
      const selection = append
        ? { version: w.application.documentVersion(id), head: content.length }
        : await app.editor.getSelection({ id });
      const uploaded = await createAttachments(w.request).upload(path, file, signal);
      if (signal.aborted) {
        w.notify(`Uploaded ${uploaded.path}; the note was closed before its link was inserted.`);
        return;
      }
      setUploadedLink(uploaded.markdown);
      const text = append
        ? `${content ? content.endsWith("\n") ? "\n" : "\n\n" : ""}${uploaded.markdown}\n`
        : uploaded.markdown;
      const changed = await app.documents.applyEdit({
        id, version: selection.version,
        from: selection.head, to: selection.head, text,
      });
      if (!append) {
        const caret = selection.head + text.length;
        await app.editor.setSelection({
          id, version: changed.version, anchor: caret, head: caret,
        });
      }
      setUploadedLink("");
      w.files.refresh();
      w.notify(`Attached ${file.name}. The note has unsaved changes.`);
    } catch (failure) {
      if (!signal.aborted) setError(String(failure));
    } finally {
      if (!signal.aborted) setBusy(false);
      operation = undefined;
    }
  }

  return (
    <div class="attachment-control">
      <IconButton
        name="link"
        label={busy() ? "Uploading attachment" : "Attach file"}
        disabled={busy() || !w.diskConnected() || w.files.busy()}
        onClick={() => input?.click()}
      />
      <input
        ref={(element) => { input = element; }}
        type="file"
        hidden
        aria-label="Choose attachment"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void attach(file);
        }}
      />
      <Show when={busy()}><span class="attachment-progress" role="status">Uploading…</span></Show>
      <Show when={error()}>
        <div class="attachment-error" role="alert">
          <p>{error()}</p>
          <Show when={uploadedLink()}>
            <label>
              Uploaded attachment link
              <input
                readonly
                value={uploadedLink()}
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
            <p>The file was uploaded. Copy this link into the changed note.</p>
          </Show>
          <button class="text-button" onClick={() => setError("")}>Dismiss</button>
        </div>
      </Show>
    </div>
  );
}
