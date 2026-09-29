import * as monaco from "monaco-editor/editor/editor.api";
import type { EditorLanguageSelection } from "./protocol";

const proposals = new WeakMap<object, () => Promise<void>>();

export function projectEditorRange(selection: EditorLanguageSelection) {
  return new monaco.Range(
    selection.start.line, selection.start.column + 1,
    selection.end.line, selection.end.column + 1,
  );
}
export function projectEditorUri(workspace: string | undefined, path: string) {
  return monaco.Uri.from({ scheme: "maghemite", authority: workspace ?? "preview", path: `/${path}` });
}
/** Monaco passes the real provider WorkspaceEdit to this service. No fake empty edit. */
export function ownProjectEdit(edit: monaco.languages.WorkspaceEdit, apply: () => Promise<void>) {
  proposals.set(edit, apply);
  return edit;
}
/** Install before createModel, which initializes Monaco's global service container. */
export const projectEditorServices = {
  // IBulkEditService's identifier in the pinned Monaco 0.57 runtime.
  IWorkspaceEditService: {
    hasPreviewHandler: () => false,
    async apply(edit: object) {
      const apply = proposals.get(edit);
      if (!apply) throw new Error("This workspace edit was not issued by an active module provider");
      await apply();
      proposals.delete(edit);
      return { isApplied: true, ariaSummary: "Applied module workspace edits" };
    },
  },
};
