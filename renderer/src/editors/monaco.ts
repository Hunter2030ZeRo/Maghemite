import { attachLanguage } from "./language";
import { projectEditorServices, projectEditorUri } from "./project_monaco";
import { installProjectPreviewPolicy } from "./project_navigation";
// JSON's lazy contribution also registers controllers that need these services.
// Register them before the standalone service container is first created.
import "monaco-editor/editor/contrib/codelens/browser/codeLensCache.js";
import "monaco-editor/editor/common/services/treeViewsDndService.js";
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/editor/browser/coreCommands.js";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard.js";
import "monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js";
import "monaco-editor/editor/contrib/find/browser/findController.js";
import "monaco-editor/editor/contrib/folding/browser/folding.js";
import "monaco-editor/editor/contrib/suggest/browser/suggestController.js";
import "monaco-editor/editor/contrib/hover/browser/hoverContribution.js";
import "monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js";
import "monaco-editor/editor/standalone/browser/referenceSearch/standaloneReferenceSearch.js";
import "monaco-editor/editor/contrib/rename/browser/rename.js";
import "monaco-editor/editor/contrib/format/browser/formatActions.js";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js";
import "monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js";
import "monaco-editor/editor/contrib/multicursor/browser/multicursor.js";
import "monaco-editor/editor/contrib/tokenization/browser/tokenization.js";
import "monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens.js";
import "monaco-editor/language/json/monaco.contribution.js";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import {
  type EditorAdapter,
  type EditorOptions,
  type EditorViewState,
  EditorText,
  palette,
  replacement,
} from "./protocol";
import { createSharedLeasePool } from "./shared_leases";

(globalThis as typeof globalThis & {
  MonacoEnvironment: { getWorker(_: string, label: string): Worker };
}).MonacoEnvironment = {
  getWorker: (_, label) =>
    label === "json" ? new JsonWorker() : new EditorWorker(),
};

let appliedTheme = "";

type SharedDocument = {
  readonly model: monaco.editor.ITextModel;
  readonly source: EditorText;
  readonly moduleFeatures: () => readonly string[];
  addView(configure: () => void): () => void;
  configure(settings: EditorOptions["settings"], language: string): void;
  language(id: string | null, features: readonly string[], owner: string): void;
  setText(
    text: string,
    selections: monaco.Selection[] | null,
  ): void;
  dispose(): void;
};

function liveOptions(current: () => EditorOptions): EditorOptions {
  return {
    get id() {
      return current().id;
    },
    get workspaceId() {
      return current().workspaceId;
    },
    get path() {
      return current().path;
    },
    get text() {
      return current().text;
    },
    get language() {
      return current().language;
    },
    get settings() {
      return current().settings;
    },
    change: (text) => current().change(text),
    selection: (anchor, head, position) =>
      current().selection(anchor, head, position),
    requestLanguage: (method, offset, start, query) =>
      current().requestLanguage?.(method, offset, start, query) ??
        Promise.resolve(null),
    openLanguageLocation: (location) =>
      current().openLanguageLocation?.(location) ?? Promise.resolve(),
    previewLanguageLocation: (location, signal) => {
      const preview = current().previewLanguageLocation;
      if (!preview) {
        return Promise.reject(new Error("Language preview is unavailable"));
      }
      return preview(location, signal);
    },
    applyWorkspaceEdit: (proposal) =>
      current().applyWorkspaceEdit?.(proposal) ?? Promise.resolve(),
    notify: (message) => current().notify?.(message),
  };
}

function createSharedDocument(
  current: () => EditorOptions,
): SharedDocument {
  const initial = current();
  let moduleLanguage: string | null = null;
  let moduleFeatures: readonly string[] = [];
  let providerKey = "";
  let applying = false;
  const views = new Set<() => void>();
  const source = new EditorText(initial.text);
  const language = (name: string) =>
    moduleLanguage ?? (name.toLowerCase() === "json" ? "json" : "plaintext");
  const model = monaco.editor.createModel(
    source.normalized(),
    language(initial.language),
    initial.workspaceId
      ? projectEditorUri(initial.workspaceId, initial.path)
      : monaco.Uri.from({ scheme: "maghemite", path: `/${initial.id}` }),
  );
  model.setEOL(monaco.editor.EndOfLineSequence.LF);
  const forwarded = liveOptions(current);
  const detachLanguage = attachLanguage(
    model,
    source,
    forwarded,
    (feature) => moduleLanguage !== null && moduleFeatures.includes(feature),
  );
  const changes = model.onDidChangeContent((event) => {
    if (applying) return;
    source.apply(event.changes.map((change) => ({
      from: source.offset(
        change.range.startLineNumber,
        change.range.startColumn - 1,
      ),
      to: source.offset(
        change.range.endLineNumber,
        change.range.endColumn - 1,
      ),
      text: change.text,
    })));
    current().change(source.text);
  });

  return {
    model,
    source,
    moduleFeatures: () => moduleFeatures,
    addView(configure) {
      views.add(configure);
      return () => views.delete(configure);
    },
    configure(settings, name) {
      model.updateOptions({ tabSize: settings.tabSize, insertSpaces: true });
      if (model.getLanguageId() !== language(name)) {
        monaco.editor.setModelLanguage(model, language(name));
      }
    },
    language(id, features, owner) {
      const key = JSON.stringify([id, features, owner]);
      if (providerKey === key) return;
      providerKey = key;
      moduleLanguage = id;
      moduleFeatures = features;
      if (id && !monaco.languages.getLanguages().some((item) => item.id === id)) {
        monaco.languages.register({ id });
      }
      monaco.editor.setModelLanguage(model, language(current().language));
      views.forEach((configure) => configure());
      detachLanguage.changed();
    },
    setText(text, selections) {
      if (text === source.text) return;
      source.set(text);
      const normalized = source.normalized();
      const before = model.getValue();
      if (normalized === before) return;
      const change = replacement(before, normalized);
      const start = model.getPositionAt(change.from);
      const end = model.getPositionAt(change.to);
      applying = true;
      try {
        model.pushStackElement();
        model.pushEditOperations(selections, [{
          range: new monaco.Range(
            start.lineNumber,
            start.column,
            end.lineNumber,
            end.column,
          ),
          text: change.insert,
        }], () => null);
        model.pushStackElement();
      } finally {
        applying = false;
      }
    },
    dispose() {
      changes.dispose();
      detachLanguage.dispose();
      views.clear();
      model.dispose();
    },
  };
}

const documents = createSharedLeasePool<string, EditorOptions, SharedDocument>({
  create: (_id, current) => createSharedDocument(current),
  dispose: (document) => document.dispose(),
});

export function createEditor(
  element: HTMLElement,
  options: EditorOptions,
): EditorAdapter {
  const createView = () => monaco.editor.create(element, {
    model: null,
    editContext: false,
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    ariaLabel: `Edit ${options.path}`,
    fixedOverflowWidgets: true,
    renderWhitespace: "selection",
    hover: { enabled: "on", delay: 250, sticky: true },
    padding: { top: 16, bottom: 24 },
  }, projectEditorServices);
  // createModel initializes global services too. Install the bulk-edit service
  // through the public standalone constructor before creating the first model.
  let editor: monaco.editor.IStandaloneCodeEditor | undefined = createView();
  installProjectPreviewPolicy();
  const lease = documents.acquire(options.id, options);
  const document = lease.value;
  const { model, source } = document;
  let nativeViewState: monaco.editor.ICodeEditorViewState | null = null;
  let durableViewState: EditorViewState = options.viewState ?? {
    selections: [],
    scrollTop: 0,
    scrollLeft: 0,
  };
  let selections: monaco.IDisposable | undefined;
  let scrolling: monaco.IDisposable | undefined;
  let settings = options.settings, currentLanguage = options.language;
  const getViewState = (): EditorViewState => {
    if (!editor) return durableViewState;
    return {
      selections: (editor.getSelections() ?? []).map((selection) => ({
        anchor: source.offset(
          selection.selectionStartLineNumber,
          selection.selectionStartColumn - 1,
        ),
        head: source.offset(
          selection.positionLineNumber,
          selection.positionColumn - 1,
        ),
      })),
      scrollTop: editor.getScrollTop(),
      scrollLeft: editor.getScrollLeft(),
    };
  };
  const publishViewState = (selectionChanged: boolean) => {
    durableViewState = getViewState();
    options.viewStateChanged?.(durableViewState);
    const primary = durableViewState.selections[0];
    if (selectionChanged && primary && (options.isFocused?.() ?? editor?.hasTextFocus())) {
      options.selection(
        primary.anchor,
        primary.head,
        source.position(primary.head),
      );
    }
  };
  function configureLanguage() {
    const features = document.moduleFeatures();
    editor?.updateOptions({
      wordBasedSuggestions: features.includes("completion")
        ? "off"
        : "currentDocument",
      "semanticHighlighting.enabled": features.includes("semanticTokens"),
    });
  }
  const removeView = document.addView(configureLanguage);
  function mount() {
    if (editor && selections && scrolling) return;
    editor ??= createView();
    editor.setModel(model);
    adapter.configure(settings, currentLanguage);
    configureLanguage();
    if (nativeViewState) {
      editor.restoreViewState(nativeViewState);
    } else {
      const restored = durableViewState.selections.map(({ anchor, head }) => {
        const a = source.position(anchor);
        const h = source.position(head);
        return new monaco.Selection(
          a.line,
          a.column + 1,
          h.line,
          h.column + 1,
        );
      });
      if (restored.length) editor.setSelections(restored);
      editor.setScrollPosition({
        scrollTop: durableViewState.scrollTop,
        scrollLeft: durableViewState.scrollLeft,
      });
    }
    selections = editor.onDidChangeCursorSelection(() =>
      publishViewState(true)
    );
    scrolling = editor.onDidScrollChange((event) => {
      if (event.scrollTopChanged || event.scrollLeftChanged) {
        publishViewState(false);
      }
    });
  }
  function suspend() {
    if (!editor) return;
    publishViewState(false);
    nativeViewState = editor.saveViewState();
    selections?.dispose();
    selections = undefined;
    scrolling?.dispose();
    scrolling = undefined;
    editor.dispose();
    editor = undefined;
  }
  const adapter: EditorAdapter = {
    language(id, features = [], owner = "") {
      document.language(id, features, owner);
    },
    setText(text) {
      document.setText(text, editor?.getSelections() ?? null);
    },
    select(anchor, head) {
      mount();
      const start = source.position(anchor), end = source.position(head);
      const a = model.validatePosition({
          lineNumber: start.line,
          column: start.column + 1,
        }),
        h = model.validatePosition({
          lineNumber: end.line,
          column: end.column + 1,
        });
      const activeEditor = editor;
      if (!activeEditor) return;
      activeEditor.focus();
      activeEditor.setSelection(
        new monaco.Selection(a.lineNumber, a.column, h.lineNumber, h.column),
      );
      activeEditor.revealPositionInCenterIfOutsideViewport(h);
    },
    configure(nextSettings, name) {
      settings = nextSettings;
      currentLanguage = name;
      const colors = palette();
      const theme = JSON.stringify(colors);
      if (theme !== appliedTheme) {
        monaco.editor.defineTheme("maghemite", {
          base: colors.dark ? "vs-dark" : "vs",
          inherit: true,
          rules: Object.entries({
            keyword: colors.syntax.keyword,
            type: colors.syntax.type,
            struct: colors.syntax.type,
            enum: colors.syntax.type,
            typeParameter: colors.syntax.type,
            namespace: colors.syntax.type,
            function: colors.syntax.function,
            method: colors.syntax.function,
            macro: colors.syntax.function,
            variable: colors.syntax.variable,
            parameter: colors.syntax.variable,
            property: colors.syntax.variable,
            enumMember: colors.syntax.number,
            label: colors.syntax.variable,
            decorator: colors.syntax.function,
            string: colors.syntax.string,
            number: colors.syntax.number,
            comment: colors.syntax.comment,
            operator: colors.syntax.operator,
          }).map(([token, foreground]) => ({ token, foreground })),
          colors: {
            "editor.background": colors.bg,
            "editor.foreground": colors.text,
            "editorLineNumber.foreground": colors.muted,
            "editorLineNumber.activeForeground": colors.accent,
            "editorCursor.foreground": colors.accent,
            "editor.selectionBackground": colors.selection,
            "editorWidget.background": colors.bg,
            "editorWidget.border": colors.line,
            "peekView.border": colors.accent,
            "peekViewTitle.background": colors.bg,
            "peekViewTitleLabel.foreground": colors.text,
            "peekViewTitleDescription.foreground": colors.muted,
            "peekViewEditor.background": colors.bg,
            "peekViewEditorGutter.background": colors.bg,
            "peekViewEditor.matchHighlightBackground": colors.selection,
            "peekViewResult.background": colors.bg,
            "peekViewResult.fileForeground": colors.text,
            "peekViewResult.lineForeground": colors.text,
            "peekViewResult.selectionBackground": colors.selection,
            "peekViewResult.selectionForeground": colors.text,
            "peekViewResult.matchHighlightBackground": colors.selection,
          },
        });
        monaco.editor.setTheme("maghemite");
        appliedTheme = theme;
      }
      editor?.updateOptions({
        fontFamily: settings.editorFont || colors.font,
        fontSize: settings.editorFontSize,
        lineHeight: settings.editorLineHeight,
        wordWrap: settings.wordWrap ? "on" : "off",
        lineNumbers: settings.lineNumbers ? "on" : "off",
        tabSize: settings.tabSize,
      });
      document.configure(settings, name);
    },
    diagnostics(items) {
      monaco.editor.setModelMarkers(
        model,
        "maghemite.modules",
        items.map((item) => ({
          message: item.message,
          severity: item.severity === "error"
            ? monaco.MarkerSeverity.Error
            : item.severity === "warning"
            ? monaco.MarkerSeverity.Warning
            : monaco.MarkerSeverity.Info,
          startLineNumber: item.line,
          startColumn: item.column + 1,
          endLineNumber: item.endLine ?? item.line,
          endColumn: (item.endColumn ?? item.column + 1) + 1,
        })),
      );
    },
    getViewState,
    visible: (value) => value ? mount() : suspend(),
    focus: () => {
      mount();
      editor?.focus();
    },
    undo: () => model.undo(),
    redo: () => model.redo(),
    layout: () => editor?.layout(),
    dispose() {
      suspend();
      removeView();
      lease.release();
    },
  };
  mount();
  return adapter;
}
