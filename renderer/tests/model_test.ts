import { deepStrictEqual, strictEqual } from "node:assert/strict";
import {
  decodeSession,
  defaultLayout,
  documentFromText,
  headings,
  links,
  resolveLink,
  type Session,
} from "../src/workspace/model.ts";

function session(): Session {
  return {
    version: 1,
    documents: [documentFromText("notes/Start.md", "# Start")],
    tabs: [{
      id: "doc:notes/Start.md",
      type: "document",
      documentId: "notes/Start.md",
    }],
    activeTab: "doc:notes/Start.md",
    mode: "knowledge",
    layout: { ...defaultLayout },
  };
}
Deno.test("session restores document content, view identity and layout without losing a draft", () => {
  const state = session();
  state.documents[0].content += "\nAn edited draft";
  state.layout.primaryWidth = 312;
  deepStrictEqual(decodeSession(JSON.stringify(state)), state);
});
Deno.test("invalid persisted references and duplicate identities are rejected", () => {
  for (
    const mutate of [
      (s: Session) => s.tabs[0].documentId = "missing",
      (s: Session) => s.documents.push({ ...s.documents[0] }),
      (s: Session) => s.tabs.push({ ...s.tabs[0] }),
      (s: Session) => s.activeTab = "missing",
      (s: Session) => s.layout.primaryWidth = 100000,
    ]
  ) {
    const state = session();
    mutate(state);
    strictEqual(decodeSession(JSON.stringify(state)), undefined);
  }
  strictEqual(decodeSession("invalid JSON"), undefined);
});
Deno.test("notes and code use the same document model", () => {
  const note = documentFromText("a.md", "draft");
  const code = documentFromText("a.ts", "draft");
  deepStrictEqual(Object.keys(note), Object.keys(code));
  strictEqual(note.kind, "note");
  strictEqual(code.kind, "code");
});
Deno.test("outline excludes fenced code and keeps source line positions", () => {
  deepStrictEqual(headings("# Start\n```md\n# Not a heading\n```\n## End"), [
    { level: 1, text: "Start", line: 1 },
    { level: 2, text: "End", line: 5 },
  ]);
});
Deno.test("wiki links resolve relative paths, deduplicate and exclude code samples", () => {
  const docs = [
    documentFromText(
      "notes/A.md",
      "[[B]] [[B|Label]] `[[C]]`\n```md\n[[C]]\n```",
    ),
    documentFromText("notes/B.md", ""),
    documentFromText("notes/C.md", ""),
    documentFromText("src/test.ts", "// [[C]]"),
  ];
  deepStrictEqual(links(docs), [{
    source: "notes/A.md",
    target: "notes/B.md",
  }]);
  strictEqual(resolveLink("B.md#heading", docs, docs[0])?.id, "notes/B.md");
  strictEqual(resolveLink("Missing", docs), undefined);
});

Deno.test("knowledge resolves unopened relative Markdown paths and rejects ambiguous or external targets", () => {
  const docs = [
    "a/Start.md",
    "b/Next.md",
    "one/Duplicate.md",
    "two/Duplicate.md",
  ].map((path) => documentFromText(path, ""));
  strictEqual(
    resolveLink("../b/Next.md#Heading", docs, docs[0])?.path,
    "b/Next.md",
  );
  strictEqual(resolveLink("Duplicate", docs, docs[0]), undefined);
  strictEqual(
    resolveLink("https://example.com/Next.md", docs, docs[0]),
    undefined,
  );
  docs[0].content = "[Next](../b/Next.md)\n~~~md\n[[Duplicate]]\n~~~";
  deepStrictEqual(links(docs), [{ source: "a/Start.md", target: "b/Next.md" }]);
});
