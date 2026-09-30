/// <reference lib="dom" />
import { deepStrictEqual as eq, ok, throws } from "node:assert/strict";
import { createRoot } from "solid-js";
import { createWorkspace } from "../src/workspace/store.ts";
import { decodeSession } from "../src/workspace/model.ts";

function fixture() {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const priorStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const cache = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true, value: Object.assign(new EventTarget(), { confirm: () => true }),
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true, value: {
      getItem: (key: string) => cache.get(key) ?? null,
      setItem: (key: string, text: string) => cache.set(key, text),
    },
  });
  const root = createRoot((dispose) => ({ workspace: createWorkspace(), dispose }));
  return {
    ...root, cache,
    close() {
      root.dispose();
      if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow);
      else Reflect.deleteProperty(globalThis, "window");
      if (priorStorage) Object.defineProperty(globalThis, "localStorage", priorStorage);
      else Reflect.deleteProperty(globalThis, "localStorage");
    },
  };
}

Deno.test("real workspace routes selection requests to only the active document view", () => {
  // Given a document split into independent views.
  const setup = fixture(), w = setup.workspace;
  try {
    const left = w.state.activeTab, doc = w.activeDocument();
    ok(left && doc);
    w.viewState(left, { editor: { selections: [{ anchor: 1, head: 2 }], scrollTop: 40, scrollLeft: 0 } });
    w.splitGroup();
    const right = w.state.activeTab;
    ok(right && right !== left);
    w.viewState(right, { editor: { selections: [{ anchor: 8, head: 9 }], scrollTop: 80, scrollLeft: 0 } });
    // When a module requests a selection in the active view.
    w.application.invoke("editor.setSelection", {
      id: doc.id, version: w.application.documentVersion(doc.id), anchor: 3, head: 5,
    }, "maghemite.workbench");
    // Then the request names only that view and leaves its sibling state alone.
    eq(w.requestedSelection()?.viewId, right);
    eq(w.state.tabs.find((tab) => tab.id === left)?.view?.editor?.selections, [{ anchor: 1, head: 2 }]);
    w.activate(left);
    eq(w.application.selectionFor(doc.id), { anchor: 1, head: 2 });
    eq(w.activeDocument()?.id, doc.id);
  } finally { setup.close(); }
});

Deno.test("real workspace A B A recovery restores groups active view and one dirty draft", async () => {
  // Given workspace A with a split dirty note and distinct view state.
  const setup = fixture(), w = setup.workspace;
  try {
    await w.connectHost({ id: "A", label: "A", path: "/A" }, undefined);
    w.application.invoke("documents.create", { path: "note.md", text: "draft" }, "maghemite.workbench");
    w.open("note.md");
    const left = w.state.activeTab;
    ok(left);
    w.viewState(left, { preview: false, editor: { selections: [{ anchor: 1, head: 2 }], scrollTop: 10, scrollLeft: 0 } });
    w.splitGroup();
    const right = w.state.activeTab;
    ok(right);
    w.viewState(right, { preview: true, readingScroll: 90, editor: { selections: [{ anchor: 4, head: 4 }], scrollTop: 80, scrollLeft: 0 } });
    const expected = JSON.parse(JSON.stringify(w.state));
    // When another workspace is visited and A is reopened.
    await w.connectHost({ id: "B", label: "B", path: "/B" }, undefined);
    w.application.invoke("documents.create", { path: "other.md", text: "B" }, "maghemite.workbench");
    await w.connectHost({ id: "A", label: "A", path: "/A" }, undefined);
    // Then the actual store restores A rather than leaking B or duplicating documents.
    eq(JSON.parse(JSON.stringify(w.state)), expected);
    eq(w.state.documents.map((doc) => [doc.id, doc.content, doc.savedContent]), [["note.md", "draft", ""]]);
    eq(w.state.activeTab, right);
    const snapshot = decodeSession(setup.cache.get("maghemite.workspace.v1.A") ?? null);
    eq(snapshot?.version, 2);
  } finally { setup.close(); }
});

Deno.test("real workspace shares edits and emits one document change for duplicate delivery", () => {
  // Given two views of the sample document.
  const setup = fixture(), w = setup.workspace;
  try {
    const doc = w.activeDocument();
    ok(doc);
    w.splitGroup();
    let changes = 0;
    w.application.onEvent((topic) => { if (topic === "documents.changed") changes++; });
    // When the same canonical edit is delivered twice.
    w.edit(doc.id, "shared");
    w.edit(doc.id, "shared");
    // Then there is one draft and one externally visible edit.
    eq(changes, 1);
    eq(w.state.documents.filter((item) => item.id === doc.id).map((item) => item.content), ["shared"]);
    eq(w.state.tabs.filter((tab) => tab.documentId === doc.id).length, 2);
  } finally { setup.close(); }
});

Deno.test("Develop creates code drafts and Knowledge creates Markdown notes", () => {
  const setup = fixture(), w = setup.workspace;
  try {
    w.mode("develop");
    w.newCode("src/example.py");
    eq(w.activeDocument()?.path, "src/example.py");
    eq(w.activeDocument()?.kind, "code");
    eq(w.activeDocument()?.language, "Python");
    throws(() => w.newCode("notes/example.md"), /Switch to Knowledge/);
    throws(() => w.newCode("src/example.py"), /already open/);
    w.mode("knowledge");
    w.newNote();
    ok(w.activeDocument()?.path.endsWith(".md"));
    eq(w.activeDocument()?.kind, "note");
  } finally { setup.close(); }
});
