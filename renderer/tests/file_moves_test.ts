import { deepStrictEqual as eq, ok, throws } from "node:assert/strict";
import { createWorkbenchApplication } from "../src/workspace/application.ts";
import {
  moveSession,
  movedPath,
  rewriteDeletedLinks,
  rewriteMovedLinks,
  trashSession,
} from "../../src/shared/file_moves.ts";
import {
  decodeSession,
  defaultLayout,
  documentFromText,
  type Session,
} from "../src/workspace/model.ts";

function workspace(): Session {
  const note = documentFromText("notes/A.md", "[[B#Details|Read more]]\n");
  note.diskVersion = "a".repeat(64);
  return {
    version: 1,
    documents: [note, documentFromText("notes/B.md", "# B")],
    tabs: [
      { id: "doc:notes/A.md", type: "document", documentId: "notes/A.md" },
      { id: "doc:notes/B.md", type: "document", documentId: "notes/B.md" },
      { id: "graph", type: "graph" },
    ],
    activeTab: "doc:notes/B.md",
    mode: "knowledge",
    layout: { ...defaultLayout },
  };
}

Deno.test("moving a note updates resolvable targets but preserves code and labels", () => {
  // Given wiki, Markdown, external, ambiguous and example links.
  const paths = ["notes/A.md", "notes/B.md", "one/Duplicate.md", "two/Duplicate.md"];
  const text = '[[B#Details|Label]] [read](B.md#Details "Title") [[Duplicate]]\r\n' +
    '`[[B]]` \\[[B]]\r\n```md\r\n[[B]]\r\n```\r\n[web](https://example.com/B.md)\r\n';
  // When the target moves and changes its name.
  const result = rewriteMovedLinks(text, "notes/A.md", {
    from: "notes/B.md", to: "archive/Renamed.md",
  }, paths);
  // Then only actual resolved targets change; fragments and source bytes survive.
  eq(result, '[[/archive/Renamed.md#Details|Label]] [read](../archive/Renamed.md#Details "Title") [[Duplicate]]\r\n' +
    '`[[B]]` \\[[B]]\r\n```md\r\n[[B]]\r\n```\r\n[web](https://example.com/B.md)\r\n');
  eq(rewriteMovedLinks("[B.md](<B.md>)", "notes/A.md", {
    from: "notes/B.md", to: "archive/C.md",
  }, paths), "[B.md](<../archive/C.md>)");
});

Deno.test("trashing a linked target removes links but retains visible note text", () => {
  const paths = ["notes/A.md", "notes/B.md", "src/tool.ts"];
  const content = "[[B|Read B]] [tool](../src/tool.ts) [web](https://example.com)\n" +
    "`[[B]]` \\[[B]]\n```md\n[[B]]\n```\n";
  eq(rewriteDeletedLinks(content, "notes/A.md", "notes/B.md", paths),
    "Read B [tool](../src/tool.ts) [web](https://example.com)\n" +
      "`[[B]]` \\[[B]]\n```md\n[[B]]\n```\n");
  eq(rewriteDeletedLinks(content, "notes/A.md", "src", paths),
    "[[B|Read B]] tool [web](https://example.com)\n" +
      "`[[B]]` \\[[B]]\n```md\n[[B]]\n```\n");
});

Deno.test("trash updates open note drafts and advances only a committed baseline", () => {
  const state = workspace();
  state.documents[0].content += "[[B|Another mention]]\n";
  const result = trashSession(state, "notes/B.md", "trash-id",
    state.documents.map((doc) => doc.path), [{
      path: "notes/A.md", previousVersion: "a".repeat(64), version: "b".repeat(64),
    }]);
  eq(result.session.documents[0].content, "Read more\nAnother mention\n");
  eq(result.session.documents[0].savedContent, "Read more\n");
  eq(result.session.documents[0].diskVersion, "b".repeat(64));
});

Deno.test("moving a source note keeps its relative outgoing targets correct", () => {
  // Given a relative link outside the directory being moved.
  const paths = ["notes/A.md", "references/B.md"];
  // When only the source moves deeper.
  const result = rewriteMovedLinks("[B](../references/B.md)", "notes/A.md", {
    from: "notes/A.md", to: "archive/deep/A.md",
  }, paths);
  // Then the destination is still the same document.
  eq(result, "[B](../../references/B.md)");
  eq(movedPath("notebook/a.md", { from: "note", to: "new" }), "notebook/a.md");
});

Deno.test("file moves preserve dirty text tabs and valid recovery identities", () => {
  // Given an active note with unsaved edits.
  const state = workspace();
  state.documents[1].content = "# B\nUnsaved text";
  // When its containing directory moves.
  const result = moveSession(state, { from: "notes", to: "archive" },
    state.documents.map((doc) => doc.path));
  // Then identities change together while draft and layout survive recovery.
  eq(result.session.documents[1].content, "# B\nUnsaved text");
  eq(result.session.documents[1].savedContent, "# B");
  eq(result.session.activeTab, "doc:archive/B.md");
  eq(result.session.tabs[1].documentId, "archive/B.md");
  eq(decodeSession(JSON.stringify(result.session)), JSON.parse(JSON.stringify(result.session)));
  eq(state.documents[1].path, "notes/B.md");
});

Deno.test("rewritten saved notes remain clean only after matching disk versions commit", () => {
  // Given a saved backlink and the original version used by a staged disk write.
  const state = workspace(), paths = state.documents.map((doc) => doc.path);
  const move = { from: "notes/B.md", to: "notes/C.md" };
  // When the host confirms exactly that disk baseline was updated.
  const committed = moveSession(state, move, paths, [{
    path: "notes/A.md", previousVersion: "a".repeat(64), version: "b".repeat(64),
  }]).session.documents[0];
  // Then the clean baseline advances; a mismatched baseline stays dirty and stale.
  eq(committed.content, committed.savedContent);
  eq(committed.diskVersion, "b".repeat(64));
  const conflict = moveSession(state, move, paths, [{
    path: "notes/A.md", previousVersion: "c".repeat(64), version: "d".repeat(64),
  }]).session.documents[0];
  eq(conflict.savedContent, state.documents[0].savedContent);
  eq(conflict.diskVersion, "a".repeat(64));
  eq(conflict.content, "[[/notes/C.md#Details|Read more]]\n");
});

Deno.test("moving onto an unrelated open draft is rejected before mutation", () => {
  // Given a destination draft that does not yet exist on disk.
  const state = workspace();
  // When moving another document onto its path.
  // Then no draft is silently merged or lost.
  throws(() => moveSession(state, { from: "notes/B.md", to: "notes/A.md" }, []),
    /open draft/);
  eq(state.documents.length, 2);
});

Deno.test("trashing a directory preserves dirty buffers as separate recovery drafts", () => {
  // Given one saved note and one dirty note beneath the trashed directory.
  const state = workspace();
  state.documents[1].content = "# B\nNever discard this";
  state.documents[1].diskVersion = "e".repeat(64);
  // When the filesystem directory is moved to recoverable trash.
  const result = trashSession(state, "notes", "1234567890abcdef",
    state.documents.map((doc) => doc.path));
  // Then clean views close, the dirty text remains unbound, and recovery is valid.
  eq(result.session.documents.length, 1);
  eq(result.session.documents[0].content, "# B\nNever discard this");
  eq(result.session.documents[0].savedContent, "");
  eq(result.session.documents[0].diskVersion, undefined);
  eq(result.session.activeTab, `doc:${result.recovered[0]}`);
  eq(decodeSession(JSON.stringify(result.session)), JSON.parse(JSON.stringify(result.session)));
});

Deno.test("path changes retain selections and remap the existing workspace undo entry", () => {
  // Given a versioned workspace edit and selection before the filesystem move.
  let state = workspace();
  const app = createWorkbenchApplication({
    documents: () => state.documents,
    active: () => state.tabs.find((tab) => tab.id === state.activeTab),
    mode: () => state.mode,
    edit: (id, text) => {
      const doc = state.documents.find((item) => item.id === id);
      ok(doc);
      app.changed(id);
      doc.content = text;
    },
    open() {}, layout() {}, notify() {}, output() {},
  });
  app.invoke("documents.applyEdit", {
    id: "notes/B.md", version: app.documentVersion("notes/B.md"),
    from: 3, to: 3, text: "\nDraft",
  }, "maghemite.workbench");
  eq(app.selectionFor("notes/B.md"), undefined);
  app.selection("notes/B.md", 1, 2);
  // When the session and service identities are remapped together.
  const change = moveSession(state, { from: "notes", to: "archive" },
    state.documents.map((doc) => doc.path));
  state = change.session;
  app.remapDocuments(change.ids, change.removed);
  // Then selection and undo address the moved document, not the missing old path.
  eq(app.selectionFor("archive/B.md"), { anchor: 1, head: 2 });
  app.undo();
  eq(state.documents.find((doc) => doc.path === "archive/B.md")?.content, "# B");
});
