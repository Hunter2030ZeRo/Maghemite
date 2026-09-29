import { type ChangeSet, type EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { history, isolateHistory, redo, undo } from "@codemirror/commands";
import { EditorText, replacement } from "./text.ts";

type Receiver = (changes: ChangeSet, selection?: EditorSelection) => void;

/** History belongs to the document; each receiver owns its own selection and effects. */
export class CodeMirrorDocument {
  readonly source: EditorText;
  state: EditorState;
  #views = new Map<object, Receiver>();
  #lastOrigin: object | undefined;

  constructor(text: string) {
    this.source = new EditorText(text);
    this.state = EditorState.create({ doc: this.source.normalized(), extensions: [history()] });
  }

  attach(origin: object, receive: Receiver) {
    this.#views.set(origin, receive);
    return () => this.#views.delete(origin);
  }

  get size() { return this.#views.size; }

  edit(origin: object, transaction: Transaction) {
    if (!transaction.docChanged) return;
    // The initiating view supplies the history selection, not whichever sibling edited last.
    this.state = this.state.update({
      selection: transaction.startState.selection,
      annotations: Transaction.addToHistory.of(false),
    }).state;
    const isolation = transaction.annotation(isolateHistory) ??
      (this.#lastOrigin !== origin ? "before" : undefined);
    const next = this.state.update({
      changes: transaction.changes,
      selection: transaction.newSelection,
      annotations: [
        Transaction.userEvent.of(transaction.annotation(Transaction.userEvent) ?? "input"),
        Transaction.addToHistory.of(transaction.annotation(Transaction.addToHistory) !== false),
        ...(isolation ? [isolateHistory.of(isolation)] : []),
      ],
    });
    this.#commit(next, origin, false);
    this.#lastOrigin = origin;
  }

  undo(origin: object, backwards = true) {
    return (backwards ? undo : redo)({
      state: this.state,
      dispatch: (transaction) => this.#commit(transaction, origin, true),
    });
  }

  setText(text: string) {
    if (text === this.source.text) return;
    const before = this.state.doc.toString();
    this.source.set(text);
    const after = this.source.normalized();
    if (before === after) return;
    const next = this.state.update({
      changes: replacement(before, after),
      annotations: [Transaction.userEvent.of("input.external"), isolateHistory.of("full")],
    });
    this.state = next.state;
    this.#lastOrigin = undefined;
    for (const receive of this.#views.values()) receive(next.changes);
  }

  #commit(transaction: Transaction, origin: object, includeOrigin: boolean) {
    const edits: { from: number; to: number; text: string }[] = [];
    const raw = (offset: number) => {
      const line = transaction.startState.doc.lineAt(offset);
      return this.source.offset(line.number, offset - line.from);
    };
    transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) =>
      edits.push({ from: raw(from), to: raw(to), text: inserted.toString() }));
    this.source.apply(edits);
    this.state = transaction.state;
    for (const [view, receive] of this.#views) {
      if (view !== origin || includeOrigin) {
        receive(transaction.changes, view === origin ? transaction.newSelection : undefined);
      }
    }
  }
}

const documents = new Map<string, CodeMirrorDocument>();

export function acquireCodeMirrorDocument(id: string, text: string) {
  let document = documents.get(id);
  if (!document) {
    document = new CodeMirrorDocument(text);
    documents.set(id, document);
  }
  const shared = document;
  return {
    document: shared,
    release() {
      if (!shared.size) documents.delete(id);
    },
  };
}
