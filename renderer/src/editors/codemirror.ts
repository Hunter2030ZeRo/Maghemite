import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import {
  defaultKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { setDiagnostics } from "@codemirror/lint";
import {
  type EditorAdapter,
  type EditorOptions,
  palette,
} from "./protocol";
import { acquireCodeMirrorDocument } from "./codemirror_document";

export function createEditor(
  element: HTMLElement,
  options: EditorOptions,
): EditorAdapter {
  const configuration = new Compartment();
  const lease = acquireCodeMirrorDocument(options.id, options.text);
  const shared = lease.document, source = shared.source, origin = {};
  const rawOffset = (offset: number, doc: EditorState["doc"]) => {
    const line = doc.lineAt(offset);
    return source.offset(line.number, offset - line.from);
  };
  const viewOffset = (offset: number) => {
    const position = source.position(offset),
      row = shared.state.doc.line(position.line);
    return Math.min(
      shared.state.doc.length,
      row.to + 1,
      row.from + position.column,
    );
  };
  const editor = new EditorView({
    parent: element,
    dispatchTransactions(transactions, view) {
      for (const transaction of transactions) shared.edit(origin, transaction);
      view.update(transactions);
      if (transactions.some((transaction) => transaction.docChanged)) options.change(source.text);
    },
    state: EditorState.create({
      doc: source.normalized(),
      selection: options.viewState ? EditorSelection.create(
        options.viewState.selections.map((selection) =>
          EditorSelection.range(viewOffset(selection.anchor), viewOffset(selection.head))),
      ) : undefined,
      extensions: [
        EditorState.allowMultipleSelections.of(true),
        drawSelection(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle),
        keymap.of([
          { key: "Mod-z", run: () => historyCommand(true), preventDefault: true },
          { key: "Mod-Shift-z", run: () => historyCommand(false), preventDefault: true },
          { key: "Mod-y", run: () => historyCommand(false), preventDefault: true },
          ...defaultKeymap,
          ...searchKeymap,
          ...foldKeymap,
          indentWithTab,
        ]),
        EditorView.contentAttributes.of({
          "aria-label": `Edit ${options.path}`,
          spellcheck: "false",
        }),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet || update.docChanged) {
            capture();
          }
          if ((update.selectionSet || update.docChanged || update.focusChanged) &&
            update.view.hasFocus && (options.isFocused?.() ?? true)) {
            const s = update.state.selection.main;
            options.selection(
              rawOffset(s.anchor, update.state.doc),
              rawOffset(s.head, update.state.doc),
              source.position(rawOffset(s.head, update.state.doc)),
            );
          }
        }),
        configuration.of([]),
      ],
    }),
  });
  const detach = shared.attach(origin, (changes, selection) => {
    editor.update([editor.state.update({ changes, selection })]);
  });
  function historyCommand(backwards: boolean) {
    const changed = shared.undo(origin, backwards);
    if (changed) options.change(source.text);
    return changed;
  }
  function capture() {
    options.viewStateChanged?.(getViewState());
  }
  function getViewState() {
    return {
      selections: editor.state.selection.ranges.map((selection) => ({
        anchor: rawOffset(selection.anchor, editor.state.doc),
        head: rawOffset(selection.head, editor.state.doc),
      })),
      scrollTop: editor.scrollDOM.scrollTop,
      scrollLeft: editor.scrollDOM.scrollLeft,
    };
  }
  editor.scrollDOM.addEventListener("scroll", capture, { passive: true });
  let pendingScroll = options.viewState;
  function restoreScroll() {
    if (!pendingScroll) return;
    const position = pendingScroll;
    editor.requestMeasure({
      read: () => editor.dom.clientHeight,
      write: (height) => {
        if (!height) return;
        editor.scrollDOM.scrollTop = position.scrollTop;
        editor.scrollDOM.scrollLeft = position.scrollLeft;
        pendingScroll = undefined;
      },
    });
  }
  const adapter: EditorAdapter = {
    getViewState,
    setText: (text) => shared.setText(text),
    select(anchor, head) {
      editor.dispatch({
        selection: { anchor: viewOffset(anchor), head: viewOffset(head) },
        scrollIntoView: true,
      });
      editor.focus();
    },
    configure(settings) {
      const colors = palette();
      editor.dispatch({
        effects: configuration.reconfigure([
          EditorState.tabSize.of(settings.tabSize),
          indentUnit.of(" ".repeat(settings.tabSize)),
          settings.lineNumbers ? [lineNumbers(), foldGutter()] : [],
          settings.wordWrap ? EditorView.lineWrapping : [],
          EditorView.theme({
            "&": {
              height: "100%",
              color: colors.text,
              backgroundColor: colors.bg,
              fontSize: `${settings.editorFontSize}px`,
            },
            ".cm-scroller": {
              overflow: "auto",
              fontFamily: settings.editorFont || colors.font,
              lineHeight: `${settings.editorLineHeight}px`,
            },
            ".cm-content": {
              padding: "16px 0 24px",
              caretColor: colors.accent,
            },
            ".cm-line": { padding: "0 12px" },
            ".cm-cursor": { borderLeftColor: colors.accent },
            ".cm-gutters": {
              backgroundColor: colors.bg,
              color: colors.muted,
              border: "none",
            },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
              { backgroundColor: colors.selection },
            ".cm-activeLine, .cm-activeLineGutter": {
              backgroundColor: "transparent",
            },
            ".cm-panels, .cm-tooltip": {
              backgroundColor: colors.bg,
              color: colors.text,
              borderColor: colors.line,
            },
            "&.cm-focused": { outline: "none" },
          }, { dark: colors.dark }),
        ]),
      });
    },
    diagnostics(items) {
      const offset = (line: number, column: number) => {
        const l = editor.state.doc.line(
          Math.max(1, Math.min(line, editor.state.doc.lines)),
        );
        return Math.min(l.to, l.from + column);
      };
      editor.dispatch(
        setDiagnostics(
          editor.state,
          items.map((d) => ({
            from: offset(d.line, d.column),
            to: offset(d.endLine ?? d.line, d.endColumn ?? d.column + 1),
            severity: d.severity,
            message: d.message,
          })),
        ),
      );
    },
    focus: () => editor.focus(),
    visible: (visible) => { if (visible) restoreScroll(); },
    layout: () => { editor.requestMeasure(); restoreScroll(); },
    dispose() {
      editor.scrollDOM.removeEventListener("scroll", capture);
      detach();
      editor.destroy();
      lease.release();
    },
  };
  adapter.configure(options.settings, options.language);
  restoreScroll();
  return adapter;
}
