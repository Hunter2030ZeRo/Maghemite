import type { Preferences } from "../../../src/shared/preferences.ts";
import type { Diagnostic } from "../../../modules-sdk/js/services.ts";
import type { LanguageLocation, LanguageWorkspaceEdit } from "../../../modules-sdk/js/project.ts";
import type { EditorViewState } from "../../../src/shared/workspace.ts";
export type { EditorViewState } from "../../../src/shared/workspace.ts";

export type EditorLanguageSelection = {
  start: { line: number; column: number };
  end: { line: number; column: number };
};
export type EditorLanguageLocation = LanguageLocation & {
  proposal: string;
  selection: EditorLanguageSelection;
};
export type EditorLanguageEdit = {
  proposal: string;
  documents: readonly (Omit<LanguageWorkspaceEdit["documents"][number], "edits"> & {
    edits: readonly (LanguageWorkspaceEdit["documents"][number]["edits"][number] & {
      selection: EditorLanguageSelection;
    })[];
  })[];
};
export type EditorLanguageQuery = {
  signal?: AbortSignal;
  newName?: string;
  includeDeclaration?: boolean;
};

export interface EditorOptions {
  id: string;
  workspaceId?: string;
  path: string;
  text: string;
  language: string;
  settings: Preferences;
  viewState?: EditorViewState;
  viewStateChanged?(state: EditorViewState): void;
  isFocused?(): boolean;
  isVisible?(): boolean;
  change(text: string): void;
  selection(
    anchor: number,
    head: number,
    position: { line: number; column: number },
  ): void;
  requestLanguage?(
    method: string,
    offset?: number,
    start?: number,
    query?: EditorLanguageQuery,
  ): Promise<unknown>;
  openLanguageLocation?(location: EditorLanguageLocation): Promise<void>;
  previewLanguageLocation?(location: EditorLanguageLocation, signal: AbortSignal): Promise<string>;
  applyWorkspaceEdit?(proposal: string): Promise<void>;
  notify?(message: string): void;
}
/** Both engines use UTF-16 offsets and the same document transaction boundary. */
export interface EditorAdapter {
  getViewState(): EditorViewState;
  setText(text: string): void;
  select(anchor: number, head: number): void;
  configure(settings: Preferences, language: string): void;
  diagnostics(items: Diagnostic[]): void;
  language?(
    id: string | null,
    features?: readonly string[],
    owner?: string,
  ): void;
  /** Suspend the view while preserving the document model and undo history. */
  visible?(value: boolean): void;
  focus(): void;
  layout(): void;
  dispose(): void;
}
export { EditorText, replacement } from "./text.ts";
export function palette() {
  const style = getComputedStyle(document.documentElement);
  const read = (key: string) => style.getPropertyValue(key).trim();
  return {
    bg: read("--bg"),
    text: read("--text"),
    muted: read("--muted"),
    accent: read("--accent"),
    selection: read("--selection"),
    line: read("--line"),
    font: read("--font-code"),
    dark: style.colorScheme !== "light",
    syntax: {
      keyword: read("--syntax-keyword"),
      type: read("--syntax-type"),
      function: read("--syntax-function"),
      variable: read("--syntax-variable"),
      string: read("--syntax-string"),
      number: read("--syntax-number"),
      comment: read("--syntax-comment"),
      operator: read("--syntax-operator"),
    },
  };
}
