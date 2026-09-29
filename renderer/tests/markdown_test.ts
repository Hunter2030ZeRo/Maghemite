import {
  deepStrictEqual as eq,
  match,
  ok,
  strictEqual,
} from "node:assert/strict";
import {
  renderMarkdown,
  resolveMarkdownTarget,
  resolveWikiTarget,
} from "../src/workspace/markdown.ts";

const options = {
  documentId: "notes/시작.md",
  currentPath: "notes/시작.md",
  documents: [
    { path: "notes/시작.md" },
    { path: "notes/다음.md" },
    { path: "reference/Guide.md" },
  ],
};

Deno.test("CommonMark and nested GFM render semantic structures with source lines", () => {
  // Given CRLF Markdown containing every supported block family and Unicode.
  const source = [
    "# 제목",
    "",
    "###### Six",
    "",
    "1. ordered",
    "   - [x] nested task",
    "   - [ ] open task",
    "",
    "> quote with **strong**, *emphasis*, and ~~strike~~",
    "",
    "| A | B |",
    "| - | -: |",
    "| one | two |",
    "",
    "    indented <code>",
    "",
    "```ts",
    "<script>alert(1)</script>",
    "```",
    "",
    "---",
  ].join("\r\n");
  // When the standards parser renders it.
  const html = renderMarkdown(source, options);
  // Then structure, task state, escaped code, and CRLF line mapping survive.
  match(html, /<h1[^>]*data-line="1"[^>]*>제목<\/h1>/);
  match(html, /<h6[^>]*data-line="3"[^>]*>Six<\/h6>/);
  match(html, /<ol>[\s\S]*<ul>[\s\S]*task-checkbox[^>]*checked/);
  match(html, /<table>[\s\S]*<th>A<\/th>[\s\S]*text-align:right/);
  ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  ok(html.includes("<hr>"));
});

Deno.test("preview preserves wiki aliases and fragments for open-file routing", () => {
  // Given existing and unopened note targets.
  const source = "[[다음#세부|별칭]] [[New note#Part|Create]]";
  // When rendered from a nested workspace note.
  const html = renderMarkdown(source, options);
  // Then both links retain path, alias, and fragment metadata.
  match(
    html,
    /data-workspace-link="notes\/다음\.md" data-note-fragment="세부">별칭/,
  );
  match(
    html,
    /data-workspace-link="notes\/New note\.md" data-note-fragment="Part">Create/,
  );
  eq(
    resolveWikiTarget("../reference/Guide#API", options),
    { kind: "workspace", path: "reference/Guide.md", fragment: "API" },
  );
});

Deno.test("raw HTML executable URLs and remote images never become active content", () => {
  // Given untrusted HTML, URL schemes, and remote/local images.
  const source = [
    "<img src=x onerror=alert(1)>",
    "[bad](javascript:alert(1)) [web](https://example.com/a)",
    "![remote](https://example.com/pixel.png)",
    "![local](./media/picture.png)",
  ].join("\n\n");
  // When preview HTML is generated.
  const html = renderMarkdown(source, options);
  // Then source HTML is escaped, unsafe links are inert, and only local images
  // receive attachment metadata without a network-loading src.
  ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  ok(!html.includes('href="javascript:'));
  ok(html.includes("[bad](javascript:alert(1))"));
  match(html, /Remote image blocked: remote/);
  match(html, /<img data-attachment="notes\/media\/picture\.png" alt="local"/);
  ok(!html.includes('src="https://example.com/pixel.png"'));
  match(html, /href="https:\/\/example\.com\/a"[^>]*noopener/);
});

Deno.test("workspace URL resolution accepts safe links and rejects traversal", () => {
  eq(resolveMarkdownTarget("../reference/Guide.md#API", "notes/a.md"), {
    kind: "workspace",
    path: "reference/Guide.md",
    fragment: "API",
  });
  eq(resolveMarkdownTarget("#세부", "notes/a.md"), {
    kind: "fragment",
    fragment: "세부",
  });
  strictEqual(resolveMarkdownTarget("mailto:user@example.com", "notes/a.md").kind, "external");
  strictEqual(resolveMarkdownTarget("../../secret", "notes/a.md").kind, "blocked");
  strictEqual(resolveMarkdownTarget("%2e%2e/%2e%2e/secret", "notes/a.md").kind, "blocked");
  strictEqual(resolveMarkdownTarget("data:text/html,boom", "notes/a.md").kind, "blocked");
  strictEqual(resolveMarkdownTarget("..%5csecret", "notes/a.md").kind, "blocked");
});
