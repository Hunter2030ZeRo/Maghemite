import { deepStrictEqual as eq, throws } from "node:assert/strict";
import {
  codeEdges, CodeLinkError, type CodeSymbol, parseCodeSymbol, parseSymbolFragment,
  selectCodeSymbol, symbolFragment, symbolMarkdown, symbolRange,
} from "../src/workspace/code_links.ts";
import { rewriteDeletedLinks, rewriteMovedLinks } from "../../src/shared/file_moves.ts";

const text = "// 😀\r\nfunction 함수() {}\r\n";
const prefix = "// 😀\r\nfunction ";
const symbol: CodeSymbol = {
  path: "src/한글.ts", name: "함수", kind: "function", container: "",
  version: "a".repeat(64), line: 2,
  startByte: new TextEncoder().encode(prefix).length,
  endByte: new TextEncoder().encode(prefix + "함수").length,
};

Deno.test("symbol anchors preserve Unicode and identify overloads at their saved version", () => {
  // Given a Unicode indexed symbol and another same-name declaration.
  const other = { ...symbol, line: 8, startByte: 100, endByte: 106 };
  // When the portable fragment is decoded.
  const anchor = parseSymbolFragment(decodeURIComponent(symbolFragment(symbol)));
  if (!anchor) throw new Error("Missing parsed anchor");
  // Then exact saved overloads resolve, while changed ambiguous ones do not guess.
  eq(selectCodeSymbol([symbol, other], anchor), symbol);
  throws(() => selectCodeSymbol([
    { ...symbol, version: "b".repeat(64) }, { ...other, version: "b".repeat(64) },
  ], anchor), /ambiguous/);
  eq(parseSymbolFragment("symbol:[1]"), undefined);
});

Deno.test("symbol byte ranges map to original UTF-16 and reject stale text", () => {
  // Given a saved file with CRLF and non-ASCII text.
  const parsed = parseCodeSymbol(symbol);
  eq(parsed, symbol);
  // When its indexed range is resolved against the displayed version.
  eq(symbolRange(symbol, text, symbol.version), { from: prefix.length, to: prefix.length + 2 });
  // Then neither another disk version nor changed source can produce a selection.
  throws(() => symbolRange(symbol, text, "b".repeat(64)), /stale/);
  throws(() => symbolRange(symbol, text.replace("함수", "다른"), symbol.version), /matches/);
});

Deno.test("code-note links remain bidirectional after a file move", () => {
  // Given a generated note link to a code symbol.
  const markdown = symbolMarkdown(symbol);
  const target = markdown.slice(markdown.indexOf("(<") + 2, -2);
  eq(codeEdges([{ source: "notes/Plan.md", target, line: 4 }], [symbol.path])[0]?.target, symbol.path);
  // When the code file moves through the real link-rewrite helper.
  const moved = rewriteMovedLinks(markdown, "notes/Plan.md", {
    from: "src/한글.ts", to: "lib/한글.ts",
  }, ["notes/Plan.md", symbol.path]);
  const movedTarget = moved.slice(moved.indexOf("(<") + 2, -2);
  // Then both the destination and symbol identity survive.
  const edges = codeEdges([{ source: "notes/Plan.md", target: movedTarget, line: 4 }], ["lib/한글.ts"]);
  eq(edges[0]?.target, "lib/한글.ts");
  eq(edges[0]?.symbol.name, symbol.name);
});

Deno.test("generated symbol targets never exceed the native indexing limit", () => {
  throws(() => symbolMarkdown({ ...symbol, path: `${"a".repeat(1000)}.ts` }), CodeLinkError);
});

Deno.test("a renamed symbol on the same indexed line remains navigable", () => {
  const anchor = parseSymbolFragment(decodeURIComponent(symbolFragment(symbol)));
  if (!anchor) throw new Error("Missing parsed anchor");
  const renamed = { ...symbol, name: "새함수", version: "b".repeat(64) };
  eq(selectCodeSymbol([renamed], anchor), renamed);
  throws(() => selectCodeSymbol([
    renamed, { ...renamed, name: "다른함수" },
  ], anchor), /no longer exists/);
});

Deno.test("trashing a code file removes its symbol link from the note", () => {
  const markdown = symbolMarkdown(symbol);
  eq(rewriteDeletedLinks(markdown, "notes/Plan.md", symbol.path,
    ["notes/Plan.md", symbol.path]), "함수");
});
