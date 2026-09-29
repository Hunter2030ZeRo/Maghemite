export function replacement(before: string, after: string) {
  let from = 0, end = before.length, to = after.length;
  while (from < end && from < to && before[from] === after[from]) from++;
  if (from > 0 && /[\uD800-\uDBFF]/.test(before[from - 1])) from--;
  while (end > from && to > from && before[end - 1] === after[to - 1]) {
    end--;
    to--;
  }
  if (end < before.length && /[\uDC00-\uDFFF]/.test(before[end])) {
    end++;
    to++;
  }
  return { from, to: end, insert: after.slice(from, to) };
}
/** Engines normalize newlines internally. Keep SDK offsets and disk text in their original representation. */
export class EditorText {
  text: string;
  readonly eol: string;
  #starts: number[] = [0];
  constructor(text: string) {
    this.text = "";
    this.eol = text.match(/\r\n|\r|\n/)?.[0] ?? "\n";
    this.set(text);
  }
  set(text: string) {
    if (text === this.text) return;
    this.text = text;
    this.#starts = [
      0,
      ...Array.from(
        text.matchAll(/\r\n|\r|\n/g),
        (m) => m.index! + m[0].length,
      ),
    ];
  }
  normalized() {
    return this.text.replace(/\r\n|\r|\n/g, "\n");
  }
  offset(line: number, column: number) {
    return Math.min(
      this.text.length,
      (this.#starts[line - 1] ?? this.text.length) + column,
    );
  }
  position(offset: number) {
    offset = Math.max(0, Math.min(this.text.length, offset));
    let line = 0, end = this.#starts.length;
    while (line + 1 < end) {
      const middle = (line + end) >>> 1;
      if (this.#starts[middle] <= offset) line = middle;
      else end = middle;
    }
    return { line: line + 1, column: offset - this.#starts[line] };
  }
  apply(edits: { from: number; to: number; text: string }[]) {
    let text = this.text;
    for (const edit of edits.sort((a, b) => b.from - a.from)) {
      text = text.slice(0, edit.from) +
        edit.text.replace(/\r\n|\r|\n/g, this.eol) + text.slice(edit.to);
    }
    this.set(text);
  }
}
