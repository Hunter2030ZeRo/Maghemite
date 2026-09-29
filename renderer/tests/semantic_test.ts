import { deepStrictEqual, throws } from "node:assert/strict";
import { encodeSemanticTokens } from "../src/editors/semantic.ts";

Deno.test("SDK tokens convert original CRLF, Unicode and multiline ranges to Monaco coordinates", () => {
  const source = '// 😀\r\nfn a() {\n  "one\r\ntwo"\n}';
  const stringStart = source.indexOf('"'),
    stringEnd = source.lastIndexOf('"') + 1;
  deepStrictEqual([...encodeSemanticTokens(source, [
    [0, 5, 13],
    [7, 9, 12],
    [10, 11, 9],
    [stringStart, stringEnd, 14],
  ])], [
    0,
    0,
    5,
    13,
    0,
    1,
    0,
    2,
    12,
    0,
    0,
    3,
    1,
    9,
    0,
    1,
    2,
    4,
    14,
    0,
    1,
    0,
    4,
    14,
    0,
  ]);
  deepStrictEqual([...encodeSemanticTokens("", [])], []);
});

Deno.test("SDK token conversion rejects cross-page overlap and invalid boundaries", () => {
  for (
    const tokens of [[[0, 3, 1], [2, 4, 1]], [[-1, 2, 1]], [[0, 8, 1]], [[
      0,
      1,
      99,
    ]], [[1, 2, 1]]]
  ) {
    throws(() =>
      encodeSemanticTokens("😀abcd", tokens as [number, number, number][])
    );
  }
});
