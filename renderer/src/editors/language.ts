import * as monaco from "monaco-editor/editor/editor.api";
import type {
  EditorOptions, EditorLanguageLocation, EditorLanguageEdit, EditorLanguageQuery,
} from "./protocol";
import type { EditorText } from "./text";
import {
  LANGUAGE_TOKEN_LIMIT,
  type LanguageCompletionKind,
  type LanguageToken,
  type LanguageTokenPage,
  languageTokenTypes,
} from "../../../modules-sdk/js/language.ts";
import { encodeSemanticTokens } from "./semantic";
import { ownProjectEdit, projectEditorRange, projectEditorUri } from "./project_monaco";
import { projectNavigation } from "./project_navigation";
type Range = { from: number; to: number };
type Completion = {
  kind?: LanguageCompletionKind;
  label: string;
  insertText: string;
  detail: string;
  filterText: string;
  range: Range;
  additionalTextEdits?: { range: Range; text: string }[];
};

const kinds = monaco.languages.CompletionItemKind;
const completionKinds: Record<
  LanguageCompletionKind,
  monaco.languages.CompletionItemKind
> = {
  method: kinds.Method,
  function: kinds.Function,
  field: kinds.Field,
  struct: kinds.Struct,
  enum: kinds.Enum,
  enumMember: kinds.EnumMember,
  interface: kinds.Interface,
  module: kinds.Module,
  constant: kinds.Constant,
  typeParameter: kinds.TypeParameter,
  type: kinds.Class,
  keyword: kinds.Keyword,
  snippet: kinds.Snippet,
  variable: kinds.Variable,
};

/** One model's providers; the engine and all language algorithms remain in the module. */
export function attachLanguage(
  model: monaco.editor.ITextModel,
  source: EditorText,
  options: EditorOptions,
  enabled: (feature: string) => boolean,
) {
  const matches = (other: monaco.editor.ITextModel, feature: string) =>
    other === model && enabled(feature);
  const tokenListeners = new Set<(event: void) => void>();
  const navigation = projectNavigation(model, source, options);
  let generation = 0;
  const request = async (
    method: string,
    token: monaco.CancellationToken,
    offset?: number,
    start?: number,
    query?: EditorLanguageQuery,
  ) => {
    const epoch = generation;
    const controller = new AbortController();
    const cancellation = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) controller.abort();
    try {
      const result = await options.requestLanguage?.(
        method, offset, start, { ...query, signal: controller.signal },
      );
      return controller.signal.aborted || epoch !== generation || !enabled(method) ? null : result;
    } finally {
      cancellation.dispose();
    }
  };
  const offset = (p: monaco.Position) =>
    source.offset(p.lineNumber, p.column - 1);
  const range = (r: Range) => {
    const a = source.position(r.from), b = source.position(r.to);
    return new monaco.Range(a.line, a.column + 1, b.line, b.column + 1);
  };
  const disposables = [
    monaco.languages.registerCompletionItemProvider("*", {
      triggerCharacters: [".", ":"],
      async provideCompletionItems(m, position, _context, token) {
        if (!matches(m, "completion")) return null;
        const version = m.getVersionId();
        const items = await request(
          "completion",
          token,
          offset(position),
        ) as Completion[] | null;
        if (
          !items || token.isCancellationRequested || m.isDisposed() ||
          version !== m.getVersionId()
        ) return null;
        return {
          incomplete: true,
          suggestions: items.map((item) => ({
            label: item.label,
            insertText: item.insertText,
            filterText: item.filterText,
            detail: item.detail,
            range: range(item.range),
            additionalTextEdits: item.additionalTextEdits?.map((edit) => ({
              range: range(edit.range), text: edit.text,
            })),
            kind: item.kind && Object.hasOwn(completionKinds, item.kind)
              ? completionKinds[item.kind]
              : kinds.Variable,
          })),
        };
      },
    }),
    monaco.languages.registerDocumentFormattingEditProvider("*", {
      displayName: "Maghemite language module",
      async provideDocumentFormattingEdits(m, _formatOptions, token) {
        if (!matches(m, "formatting")) return null;
        const version = m.getVersionId();
        const edits = await request("formatting", token) as {
          range: Range;
          text: string;
        }[] | null;
        if (
          !edits || token.isCancellationRequested || m.isDisposed() ||
          version !== m.getVersionId() || !matches(m, "formatting")
        ) return null;
        return edits.map((edit) => ({
          range: range(edit.range),
          text: edit.text,
        }));
      },
    }),
    monaco.languages.registerHoverProvider("*", {
      async provideHover(m, position, token) {
        if (!matches(m, "hover")) return null;
        const version = m.getVersionId();
        const item = await request(
          "hover",
          token,
          offset(position),
        ) as { text: string; range: Range } | null;
        if (
          !item || token.isCancellationRequested || m.isDisposed() ||
          version !== m.getVersionId()
        ) return null;
        return {
          range: range(item.range),
          contents: [{
            value: item.text,
            isTrusted: false,
            supportHtml: false,
          }],
        };
      },
    }),
    monaco.languages.registerDefinitionProvider("*", {
      async provideDefinition(m, position, token) {
        if (!matches(m, "definition")) return null;
        const version = m.getVersionId();
        const items = await request(
          "definition",
          token,
          offset(position),
        ) as (EditorLanguageLocation | { range: Range })[] | null;
        if (
          !items || token.isCancellationRequested || m.isDisposed() ||
          version !== m.getVersionId()
        ) return null;
        return navigation.resolve(items, token);
      },
    }),
    monaco.languages.registerReferenceProvider("*", {
      async provideReferences(m, position, context, token) {
        if (!matches(m, "references")) return null;
        const version = m.getVersionId();
        const items = await request("references", token, offset(position), undefined, {
          includeDeclaration: context.includeDeclaration,
        }) as EditorLanguageLocation[] | null;
        if (!items || token.isCancellationRequested || m.isDisposed() ||
          m.getVersionId() !== version) return null;
        return navigation.resolve(items, token);
      },
    }),
    monaco.languages.registerRenameProvider("*", {
      async provideRenameEdits(m, position, newName, token) {
        if (!matches(m, "rename") || !options.applyWorkspaceEdit) return null;
        const version = m.getVersionId(), epoch = generation;
        const result = await request("rename", token, offset(position), undefined, {
          newName,
        }) as EditorLanguageEdit | null;
        if (!result || token.isCancellationRequested || m.isDisposed() ||
          m.getVersionId() !== version) return null;
        const edits: monaco.languages.IWorkspaceTextEdit[] = result.documents.flatMap((d) =>
          d.edits.map((e) => ({
            resource: projectEditorUri(options.workspaceId, d.path),
            versionId: d.path === options.path ? version : undefined,
            textEdit: { range: projectEditorRange(e.selection), text: e.text },
          }))
        );
        if (!edits.length) return { edits: [], rejectReason: "The module proposed no rename edits" };
        return ownProjectEdit({ edits }, async () => {
          if (m.isDisposed() || m.getVersionId() !== version || generation !== epoch ||
            !enabled("rename")) throw new Error("Language edit is stale; request rename again");
          await options.applyWorkspaceEdit?.(result.proposal);
        });
      },
    }),
    monaco.languages.registerDocumentSemanticTokensProvider("*", {
      onDidChange(listener) {
        tokenListeners.add(listener);
        return {
          dispose: () => {
            tokenListeners.delete(listener);
          },
        };
      },
      getLegend: () => ({
        tokenTypes: [...languageTokenTypes],
        tokenModifiers: [],
      }),
      releaseDocumentSemanticTokens() {},
      async provideDocumentSemanticTokens(m, _previous, cancellation) {
        if (!matches(m, "semanticTokens")) return null;
        const version = m.getVersionId(), original = source.text;
        const tokens: LanguageToken[] = [];
        let start = 0;
        do {
          if (
            cancellation.isCancellationRequested || m.isDisposed() ||
            version !== m.getVersionId() || !matches(m, "semanticTokens")
          ) return null;
          const page = await request(
            "semanticTokens",
            cancellation,
            undefined,
            start,
          ) as LanguageTokenPage | null;
          if (
            !page || cancellation.isCancellationRequested || m.isDisposed() ||
            version !== m.getVersionId() || !matches(m, "semanticTokens")
          ) return null;
          if (
            tokens.length + page.tokens.length > LANGUAGE_TOKEN_LIMIT ||
            (page.next !== null &&
              (page.next <= start || page.next > original.length))
          ) return null;
          tokens.push(...page.tokens);
          if (page.next === null) break;
          start = page.next;
        } while (start <= original.length);
        return { data: encodeSemanticTokens(original, tokens) };
      },
    }),
  ];
  return {
    changed() {
      generation++;
      navigation.clear();
      tokenListeners.forEach((listener) => listener());
    },
    dispose() {
      generation++;
      navigation.dispose();
      tokenListeners.clear();
      disposables.forEach((item) => item.dispose());
    },
  };
}
