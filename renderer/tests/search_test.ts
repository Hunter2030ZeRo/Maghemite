import { deepStrictEqual as eq, throws } from "node:assert/strict";
import {
  draftReplacementEdits,
  searchDrafts,
  searchPathMatches,
} from "../src/workspace/search-text.ts";
import { createWorkbenchApplication } from "../src/workspace/application.ts";
import { documentFromText } from "../src/workspace/model.ts";

Deno.test("draft search preserves UTF-16 positions and CRLF line boundaries", () => {
  // Given an unsaved document with an astral character and CRLF.
  const document = {
    id: "notes/한글.md",
    path: "notes/한글.md",
    version: "draft:1",
    content: "😀 Needle\r\nneedle",
  };
  // When case-insensitive search overlays the draft.
  const result = searchDrafts([document], { query: "needle" });
  // Then ranges address the exact source, not normalized editor text.
  eq(result.matches.map(({ from, to, line, column }) =>
    ({ from, to, line, column })
  ), [
    { from: 3, to: 9, line: 1, column: 3 },
    { from: 11, to: 17, line: 2, column: 0 },
  ]);
});

Deno.test("draft regex previews use native dollar capture expansion", () => {
  // Given a named capture and a literal dollar in the replacement template.
  const document = { id: "a.ts", path: "a.ts", version: "v1", content: "item42" };
  // When a replacement is previewed.
  const result = searchDrafts([document], {
    query: "(?<name>item)([0-9]+)",
    regex: true,
    replacement: "${name}-$2-$$-$0",
  });
  // Then the same explicit capture semantics as the native search are used.
  eq(result.matches[0].replacement, "item-42-$-item42");
  eq(document.content, "item42");
});

Deno.test("draft search handles literal metacharacters and case filters", () => {
  // Given literal regex punctuation and differently cased occurrences.
  const document = {
    id: "a.ts", path: "a.ts", version: "v1", content: "A.b a.b axb",
  };
  // When searching literally with case sensitivity.
  const result = searchDrafts([document], { query: "a.b", caseSensitive: true });
  // Then punctuation is not interpreted as an expression.
  eq(result.matches.map((m) => m.from), [4]);
});

Deno.test("draft search filters paths and reports bounded results", () => {
  // Given matching text in source and excluded generated files.
  const documents = ["src/a.ts", "src/generated/a.ts", "notes/a.md"].map((path) => ({
    id: path, path, version: "v1", content: "x x x",
  }));
  // When includes, exclusions and a result limit are combined.
  const result = searchDrafts(documents, {
    query: "x", include: ["**/*.ts"], exclude: ["**/generated/**"], maxResults: 2,
  });
  // Then only eligible source matches are emitted with an explicit limit signal.
  eq(result.matches.map((m) => m.path), ["src/a.ts", "src/a.ts"]);
  eq(result.truncated, true);
  eq(searchPathMatches("a.ts", ["**/*.ts"]), true);
  eq(searchPathMatches("nested/a.ts", ["*.ts"]), true);
  eq(searchPathMatches("a/b", ["a?b"]), true);
  throws(() => searchDrafts([], { query: "[", regex: true }), /Invalid search/);
  throws(() => searchDrafts([], { query: "x", include: ["[ab]"] }), /wildcards/);
});

Deno.test("zero-length draft matches advance across complete Unicode characters", () => {
  // Given two Unicode characters occupying three UTF-16 units.
  const document = { id: "a", path: "a", version: "v1", content: "😀a" };
  // When the expression matches empty positions.
  const result = searchDrafts([document], { query: "(?:)", regex: true });
  // Then no surrogate pair is split and the loop terminates.
  eq(result.matches.map((m) => m.from), [0, 2, 3]);
});

Deno.test("a leading newline does not shift the first empty match column", () => {
  // Given a draft beginning with a line break.
  const document = { id: "a", path: "a", version: "v1", content: "\nx" };
  // When matching an insertion point at the start of the document.
  const result = searchDrafts([document], { query: "^", regex: true });
  // Then the first result is at the beginning of the first line.
  eq(result.matches[0].column, 0);
});

Deno.test("all file filters are validated even after an earlier wildcard matches", () => {
  // Given an invalid pattern following a valid catch-all.
  const options = { query: "x", include: ["*", "[invalid]"] };
  // When starting a search without open drafts.
  // Then invalid filters fail before any disk request.
  throws(() => searchDrafts([], options), /wildcards/);
});

Deno.test("selected draft replacement rejects stale snapshots and supports undo", () => {
  // Given a real workbench draft and its versioned search snapshot.
  const document = documentFromText("a.md", "old old");
  const app = createWorkbenchApplication({
    documents: () => [document],
    active: () => ({ type: "document", documentId: document.id }),
    mode: () => "knowledge",
    edit: (_, content) => {
      app.changed(document.id);
      document.content = content;
    },
    open() {}, layout() {}, notify() {}, output() {},
  });
  const snapshot = {
    id: document.id, path: document.path, content: document.content,
    version: app.documentVersion(document.id),
  };
  const matches = searchDrafts([snapshot], { query: "old", replacement: "new" }).matches;
  // When only the second match is applied through the existing edit boundary.
  const edits = draftReplacementEdits([matches[1]], [snapshot], app.documentVersion);
  app.invoke("documents.applyEdits", { edits }, "maghemite.workbench");
  // Then the first match and saved content stay unchanged; stale edits cannot apply.
  eq(document.content, "old new");
  eq(document.savedContent, "old old");
  throws(() =>
    draftReplacementEdits([matches[0]], [snapshot], app.documentVersion),
    /Draft changed/
  );
  app.undo();
  eq(document.content, "old old");
});
