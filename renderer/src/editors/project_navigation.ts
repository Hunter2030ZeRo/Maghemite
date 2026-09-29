import * as monaco from "monaco-editor/editor/editor.api";
import { EditorText } from "./text";
import type { EditorLanguageLocation, EditorOptions } from "./protocol";
import { projectEditorRange, projectEditorUri } from "./project_monaco";

const previewScheme = "maghemite-reference";
let previewPolicyInstalled = false;

/** Reference snapshots are not editable documents. Open the real target to edit. */
export function installProjectPreviewPolicy() {
  if (previewPolicyInstalled) return;
  previewPolicyInstalled = true;
  monaco.editor.onDidCreateEditor((editor) => {
    const model = editor.onDidChangeModel(() => {
      if (editor.getModel()?.uri.scheme === previewScheme) {
        editor.updateOptions({ readOnly: true });
      }
    });
    const disposed = editor.onDidDispose(() => {
      model.dispose();
      disposed.dispose();
    });
  });
}

export function projectNavigation(
  model: monaco.editor.ITextModel,
  source: EditorText,
  options: EditorOptions,
) {
  const locations = new Map<string, EditorLanguageLocation[]>();
  const batches: monaco.editor.ITextModel[][] = [];
  const pending = new Set<AbortController>();
  const opener = monaco.editor.registerEditorOpener({
    async openCodeEditor(_editor, resource, selection) {
      const candidates = locations.get(resource.toString());
      if (!candidates || !options.openLanguageLocation) return false;
      const start = selection && ("startLineNumber" in selection
        ? { line: selection.startLineNumber, column: selection.startColumn - 1 }
        : { line: selection.lineNumber, column: selection.column - 1 });
      const location = start
        ? candidates.find((candidate) => candidate.selection.start.line === start.line &&
          candidate.selection.start.column === start.column)
        : candidates[0];
      if (!location) return false;
      try {
        await options.openLanguageLocation(location);
      } catch (error) {
        options.notify?.(String(error));
      }
      return true;
    },
  });
  const drop = (models: readonly monaco.editor.ITextModel[]) => {
    for (const preview of models) {
      locations.delete(preview.uri.toString());
      preview.dispose();
    }
  };
  const clear = () => {
    for (const request of pending) request.abort();
    batches.splice(0).forEach(drop);
  };
  return {
    async resolve(
      items: readonly (EditorLanguageLocation | { range: { from: number; to: number } })[],
      token: monaco.CancellationToken,
    ) {
      const controller = new AbortController();
      pending.add(controller);
      const cancellation = token.onCancellationRequested(() => controller.abort());
      if (token.isCancellationRequested) controller.abort();
      const grouped = new Map<string, EditorLanguageLocation[]>();
      for (const item of items) {
        if (!("proposal" in item)) continue;
        const uri = projectEditorUri(options.workspaceId, item.path).with({
          scheme: previewScheme,
          query: new URLSearchParams({ proposal: item.proposal }).toString(),
        }).toString();
        const group = grouped.get(uri) ?? [];
        group.push(item);
        grouped.set(uri, group);
      }
      const created: monaco.editor.ITextModel[] = [];
      try {
        for (const [uri, group] of grouped) {
          controller.signal.throwIfAborted();
          if (!options.previewLanguageLocation) throw new Error("Language preview is unavailable");
          const text = await options.previewLanguageLocation(group[0], controller.signal);
          controller.signal.throwIfAborted();
          created.push(monaco.editor.createModel(
            new EditorText(text).normalized(), "plaintext", monaco.Uri.parse(uri),
          ));
          locations.set(uri, group);
        }
        // Monaco may request a second, declaration-free result before using the first.
        batches.push(created);
        while (batches.length > 2) {
          const oldest = batches.shift();
          if (oldest) drop(oldest);
        }
        return items.map((item) => {
          if ("proposal" in item) {
            return {
              uri: projectEditorUri(options.workspaceId, item.path).with({
                scheme: previewScheme,
                query: new URLSearchParams({ proposal: item.proposal }).toString(),
              }),
              range: projectEditorRange(item.selection),
            };
          }
          const start = source.position(item.range.from), end = source.position(item.range.to);
          return { uri: model.uri, range: new monaco.Range(
            start.line, start.column + 1, end.line, end.column + 1,
          ) };
        });
      } catch (error) {
        drop(created);
        if (!controller.signal.aborted) options.notify?.(`Language preview: ${String(error)}`);
        throw error;
      } finally {
        pending.delete(controller);
        cancellation.dispose();
      }
    },
    clear,
    dispose() { clear(); opener.dispose(); },
  };
}
