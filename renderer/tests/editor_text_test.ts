import { deepStrictEqual as same, strictEqual as eq } from "node:assert/strict";
import { EditorText, replacement } from "../src/editors/text.ts";
Deno.test("editor mapping preserves CRLF, mixed newline text and UTF-16 source positions", () => {
  const source = new EditorText("a\r\n한글😀\r\nb\nend");
  eq(source.normalized(), "a\n한글😀\nb\nend");
  eq(source.offset(2, 2), 5);
  same(source.position(5), { line: 2, column: 2 });
  const from = source.offset(2, 2), to = source.offset(2, 4);
  source.apply([{ from, to, text: "X\nY" }]);
  eq(source.text, "a\r\n한글X\r\nY\r\nb\nend");
  source.set("prefix\na\r\n한글😀\r\nb\nend");
  eq(source.offset(3, 2), 12);
  same(source.position(12), { line: 3, column: 2 });
});
Deno.test("minimal external edits never split surrogate pairs", () => {
  for (
    const [before, after] of [["A😀Z", "A😁Z"], ["한😀글", "한글"], [
      "abc",
      "abc",
    ], ["", "😀"]]
  ) {
    const change = replacement(before, after);
    eq(
      before.slice(0, change.from) + change.insert + before.slice(change.to),
      after,
    );
    if (change.from > 0) {
      eq(/[\uD800-\uDBFF]/.test(before[change.from - 1]), false);
    }
  }
});

Deno.test("line mapping round-trips offsets across large mixed-newline documents", () => {
  const source = new EditorText("");
  same(source.position(0), { line: 1, column: 0 });
  const text = Array.from(
    { length: 10000 },
    (_, i) => `line ${i} 한😀${i % 2 ? "\r\n" : "\n"}`,
  ).join("");
  source.set(text);
  source.set(text);
  for (let offset = 0; offset <= text.length; offset += 137) {
    const position = source.position(offset);
    eq(source.offset(position.line, position.column), offset);
    eq(position.line, text.slice(0, offset).split(/\r\n|\n/).length);
  }
  same(source.position(text.length), { line: 10001, column: 0 });
});
