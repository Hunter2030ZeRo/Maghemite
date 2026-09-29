import { deepStrictEqual as eq, ok, strictEqual } from "node:assert/strict";
import {
  activateView, addView, closeGroup, closeView, focusGroup, groupedSession,
  moveView, recoverableSession, resizeGroups, splitGroup,
} from "../src/workspace/groups.ts";
import {
  decodeSession, defaultLayout, documentFromText, type GroupSession, type Session,
} from "../src/workspace/model.ts";
import { moveSession, trashSession } from "../../src/shared/file_moves.ts";

function legacy(): Session {
  const open = documentFromText("notes/A.md", "# A\nDraft");
  open.savedContent = "# A";
  const closed = documentFromText("closed.ts", "unsaved");
  closed.savedContent = "";
  return {
    version: 1, documents: [open, closed],
    tabs: [{ id: "doc:notes/A.md", type: "document", documentId: open.id }],
    activeTab: "doc:notes/A.md", mode: "knowledge", layout: { ...defaultLayout },
  };
}
function split(): GroupSession {
  return splitGroup(groupedSession(legacy()), "group:main", "group:right", "view:right");
}
function valid(session: GroupSession) {
  eq(decodeSession(JSON.stringify(session)), JSON.parse(JSON.stringify(session)));
}

Deno.test("legacy migration preserves open and closed dirty drafts in one group", () => {
  // Given a valid v1 recovery snapshot.
  const before = legacy(), decoded = decodeSession(JSON.stringify(before));
  ok(decoded);
  // When the renderer migrates it.
  const after = groupedSession(decoded);
  // Then migration does not replicate or discard document data.
  eq(after.documents, before.documents);
  eq(after.groups, [{ id: "group:main", tabs: ["doc:notes/A.md"], activeTab: "doc:notes/A.md", size: 1 }]);
  eq(after.activeGroup, "group:main");
  valid(after);
});

Deno.test("splitting copies view state without copying a document or sharing mutable state", () => {
  // Given a saved selection, read mode and scroll position.
  const before = groupedSession(legacy());
  before.tabs[0].view = {
    preview: false, readingScroll: 91,
    editor: { selections: [{ anchor: 2, head: 4 }], scrollTop: 120, scrollLeft: 10 },
  };
  // When a document is split.
  const after = splitGroup(before, "group:main", "group:right", "view:right");
  // Then both views reference one draft and their state records are independent.
  strictEqual(after.documents, before.documents);
  eq(after.tabs.map((tab) => tab.documentId), ["notes/A.md", "notes/A.md"]);
  eq(after.tabs[0].view, after.tabs[1].view);
  ok(after.tabs[0].view !== after.tabs[1].view);
  ok(after.tabs[0].view?.editor?.selections !== after.tabs[1].view?.editor?.selections);
  eq(after.activeGroup, "group:right");
  eq(after.activeTab, "view:right");
  valid(after);
});

Deno.test("moving a tab preserves identity and view state and selects the destination", () => {
  // Given two independent document views.
  const before = split();
  before.tabs[1].view = { preview: true, readingScroll: 300 };
  // When the right view moves left.
  const after = moveView(before, "view:right", "group:main");
  // Then it is moved exactly once and the source can remain empty.
  eq(after.groups.map((group) => group.tabs), [["doc:notes/A.md", "view:right"], []]);
  strictEqual(after.tabs[1], before.tabs[1]);
  eq(after.activeGroup, "group:main");
  eq(after.activeTab, "view:right");
  valid(after);
});

Deno.test("focus and activation project the selected view of exactly one active group", () => {
  // Given a split with different selected views.
  const before = split();
  // When the left group gains focus.
  const focused = focusGroup(before, "group:main");
  // Then application-compatible activeTab projects that group without changing the sibling.
  eq(focused.activeTab, "doc:notes/A.md");
  eq(focused.groups[1].activeTab, "view:right");
  eq(activateView(focused, "view:right").activeGroup, "group:right");
  valid(focused);
});

Deno.test("closing a group collects all its tabs and cannot close the final group", () => {
  // Given an active split containing dirty views.
  const before = split();
  // When its active group closes.
  const after = closeGroup(before, "group:right");
  // Then views and drafts remain addressable in the neighbor.
  eq(after.groups.length, 1);
  eq(after.groups[0].tabs, ["doc:notes/A.md", "view:right"]);
  eq(after.activeTab, "view:right");
  strictEqual(after.documents, before.documents);
  strictEqual(closeGroup(after, after.activeGroup), after);
  valid(after);
});

Deno.test("closing one view keeps the sibling and its dirty document", () => {
  // Given two views of a dirty document.
  const before = split();
  // When one tab closes.
  const after = closeView(before, "view:right");
  // Then only that view closes.
  eq(after.tabs.map((tab) => tab.id), ["doc:notes/A.md"]);
  strictEqual(after.documents, before.documents);
  eq(after.groups[1].activeTab, null);
  valid(after);
});

Deno.test("resize preserves total space and clamps both neighboring groups", () => {
  // Given two equal groups.
  const before = split();
  // When the first separator is dragged beyond its neighbor.
  const after = resizeGroups(before, "group:main", 10);
  // Then neither group collapses and the durable weights stay valid.
  eq(after.groups.map((group) => group.size), [0.9, 0.09999999999999998]);
  valid(after);
});

Deno.test("recovery removes runtime views and repairs group selection without losing drafts", () => {
  // Given a runtime module tab selected in the right group.
  const before = addView(split(), { id: "view:module", type: "custom" });
  // When serializing a recoverable session.
  const after = recoverableSession(before);
  // Then no dangling custom tab remains and its sibling document is selected.
  eq(after.tabs.some((tab) => tab.type === "custom"), false);
  eq(after.activeTab, "view:right");
  strictEqual(after.documents, before.documents);
  valid(after);
});

Deno.test("v2 decoder rejects duplicate membership invalid active groups and malformed view state", () => {
  // Given independently malformed boundary inputs.
  const changes: ((session: GroupSession) => void)[] = [
    (s) => { s.groups[1].tabs.push(s.groups[0].tabs[0]); },
    (s) => { s.activeGroup = "missing"; },
    (s) => { s.activeTab = s.groups[0].activeTab; },
    (s) => { s.groups[1].activeTab = "missing"; },
    (s) => { s.groups[1].size = 0; },
    (s) => { s.tabs[1].view = { editor: { selections: [{ anchor: -1, head: 0 }], scrollTop: 0, scrollLeft: 0 } }; },
    (s) => { s.tabs[1].view = { readingScroll: -1 }; },
  ];
  // When each crosses the persisted-data boundary.
  const results = changes.map((change) => {
    const session = split(); change(session);
    return decodeSession(JSON.stringify(session));
  });
  // Then none can enter the workbench as a valid session.
  eq(results, changes.map(() => undefined));
});

Deno.test("folder recovery serializes independent states and only one copy of each draft", () => {
  // Given workspace A and an unrelated workspace B snapshot.
  const a = split();
  a.tabs[0].view = { editor: { selections: [{ anchor: 1, head: 2 }], scrollTop: 10, scrollLeft: 0 }, preview: false };
  a.tabs[1].view = { editor: { selections: [{ anchor: 5, head: 5 }], scrollTop: 80, scrollLeft: 4 }, preview: true, readingScroll: 900 };
  const storage = new Map([["A", JSON.stringify(a)], ["B", JSON.stringify(groupedSession(legacy()))]]);
  // When B is visited and A is restored from its own recovery key.
  ok(decodeSession(storage.get("B") ?? null));
  const restored = decodeSession(storage.get("A") ?? null);
  // Then active group, independent state and unique draft table survive.
  eq(restored, a);
  eq(restored?.documents.length, 2);
});

Deno.test("file moves remap every split view without changing stable view identity", () => {
  // Given one note in two groups with independent state.
  const before = split();
  before.tabs[1].view = { readingScroll: 80 };
  // When its directory moves.
  const after = moveSession(before, { from: "notes", to: "archive" }, ["notes/A.md"]).session;
  // Then every reference points at the single moved document.
  eq(after.tabs.map((tab) => tab.documentId), ["archive/A.md", "archive/A.md"]);
  eq(after.tabs.map((tab) => tab.id), before.tabs.map((tab) => tab.id));
  eq(after.groups, before.groups);
  eq(after.tabs[1].view, before.tabs[1].view);
  eq(decodeSession(JSON.stringify(after)), JSON.parse(JSON.stringify(after)));
});

Deno.test("trash retains one recovered dirty draft shared by all of its views", () => {
  // Given a dirty note visible in both groups.
  const before = split();
  // When the containing directory is trashed.
  const change = trashSession(before, "notes", "1234567890abcdef", ["notes/A.md"]);
  // Then both views reference the same retained draft, not duplicate copies.
  eq(change.recovered.length, 1);
  eq(change.session.tabs.map((tab) => tab.documentId), [change.recovered[0], change.recovered[0]]);
  eq(change.session.documents.filter((doc) => doc.path === change.recovered[0]).length, 1);
  eq(change.session.activeTab, "view:right");
  eq(decodeSession(JSON.stringify(change.session)), JSON.parse(JSON.stringify(change.session)));
});

Deno.test("trash closes all clean views and leaves valid empty groups", () => {
  // Given a saved document visible in both groups.
  const before = split();
  before.documents[0].savedContent = before.documents[0].content;
  // When it is trashed.
  const after = trashSession(before, "notes", "123", ["notes/A.md"]).session;
  // Then both views close, while the closed dirty draft remains retained.
  eq(after.tabs, []);
  eq(after.groups?.map((group) => group.activeTab), [null, null]);
  eq(after.documents.map((doc) => doc.path), ["closed.ts"]);
  eq(decodeSession(JSON.stringify(after)), JSON.parse(JSON.stringify(after)));
});
