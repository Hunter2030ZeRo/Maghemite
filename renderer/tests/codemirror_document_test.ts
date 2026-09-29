import { deepStrictEqual as eq, strictEqual } from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { acquireCodeMirrorDocument, CodeMirrorDocument } from "../src/editors/codemirror_document.ts";

function view(document: CodeMirrorDocument, anchor: number) {
  const origin = {};
  let state = EditorState.create({ doc: document.source.normalized(), selection: { anchor } });
  const detach = document.attach(origin, (changes, selection) => {
    state = state.update({ changes, selection }).state;
  });
  return {
    origin, detach,
    state: () => state,
    edit(from: number, to: number, insert: string) {
      const transaction = state.update({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
        annotations: isolateHistory.of("full"),
      });
      document.edit(origin, transaction);
      state = transaction.state;
    },
  };
}

Deno.test("CodeMirror views share edits but retain independently mapped selections", () => {
  // Given two selections in one canonical document.
  const document = new CodeMirrorDocument("abcd"), left = view(document, 0), right = view(document, 4);
  // When the left view inserts text.
  left.edit(0, 0, "X");
  // Then both documents agree while the sibling caret maps rather than being replaced.
  eq([left.state().doc.toString(), right.state().doc.toString(), document.source.text], ["Xabcd", "Xabcd", "Xabcd"]);
  eq([left.state().selection.main.head, right.state().selection.main.head], [1, 5]);
});

Deno.test("CodeMirror undo from either view uses one coherent document history", () => {
  // Given edits made through different views.
  const document = new CodeMirrorDocument("abcd"), left = view(document, 0), right = view(document, 4);
  left.edit(0, 0, "X");
  right.edit(5, 5, "Y");
  // When the left view undoes the most recent edit.
  strictEqual(document.undo(left.origin), true);
  // Then both views undo the right edit without undoing unrelated text.
  eq([left.state().doc.toString(), right.state().doc.toString(), document.source.text], ["Xabcd", "Xabcd", "Xabcd"]);
  eq(right.state().selection.main.head, 5);
});

Deno.test("CodeMirror shared redo and external edits do not create duplicate history entries", () => {
  // Given one external workspace edit delivered to both adapters.
  const document = new CodeMirrorDocument("abc"), left = view(document, 0), right = view(document, 3);
  document.setText("aXbc");
  document.setText("aXbc");
  document.undo(left.origin);
  // When the sibling redoes the one shared edit.
  strictEqual(document.undo(right.origin, false), true);
  // Then both views agree, and one undo empties the shared history.
  eq([left.state().doc.toString(), right.state().doc.toString()], ["aXbc", "aXbc"]);
  strictEqual(document.undo(right.origin), true);
  strictEqual(document.undo(left.origin), false);
});

Deno.test("CodeMirror shared transactions preserve raw CRLF and Unicode offsets", () => {
  // Given raw Windows line endings and Unicode text.
  const document = new CodeMirrorDocument("a\r\n한😀\r\nz"), left = view(document, 0), right = view(document, 7);
  // When one view inserts a normalized newline.
  left.edit(2, 2, "X\n");
  // Then raw content keeps CRLF and sibling normalized text stays coherent.
  eq(document.source.text, "a\r\nX\r\n한😀\r\nz");
  eq(right.state().doc.toString(), "a\nX\n한😀\nz");
});

Deno.test("CodeMirror leases retain shared history until the last view releases", () => {
  // Given two leases of one workspace document.
  const leftLease = acquireCodeMirrorDocument("workspace/note.md", "abc");
  const rightLease = acquireCodeMirrorDocument("workspace/note.md", "abc");
  const left = view(leftLease.document, 0), right = view(rightLease.document, 3);
  left.edit(0, 0, "X");
  // When the left view closes.
  left.detach(); leftLease.release();
  // Then its sibling retains the same document and can undo.
  strictEqual(leftLease.document, rightLease.document);
  strictEqual(rightLease.document.undo(right.origin), true);
  eq(right.state().doc.toString(), "abc");
  right.detach(); rightLease.release();
  const next = acquireCodeMirrorDocument("workspace/note.md", "new");
  eq(next.document.source.text, "new");
  next.release();
});
