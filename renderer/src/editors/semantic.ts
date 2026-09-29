import {
  LANGUAGE_TOKEN_LIMIT,
  type LanguageToken,
  languageTokenTypes,
} from "../../../modules-sdk/js/language.ts";

/** Convert original-source ranges to Monaco's sorted, single-line delta encoding. */
export function encodeSemanticTokens(
  text: string,
  tokens: readonly LanguageToken[],
): Uint32Array {
  if (tokens.length > LANGUAGE_TOKEN_LIMIT) {
    throw new Error("Too many language tokens");
  }
  const starts = [0], ends: number[] = [];
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    ends.push(match.index);
    starts.push(match.index + match[0].length);
  }
  ends.push(text.length);
  const data: number[] = [];
  let line = 0, lastLine = 0, lastColumn = 0, previousEnd = 0;
  for (const [from, to, kind] of tokens) {
    if (
      ![from, to, kind].every(Number.isSafeInteger) || from < previousEnd ||
      to <= from || to > text.length || kind < 0 ||
      kind >= languageTokenTypes.length
    ) {
      throw new Error("Invalid language token ordering or range");
    }
    previousEnd = to;
    for (const boundary of [from, to]) {
      if (
        /[\uD800-\uDBFF]/.test(text[boundary - 1] ?? "") &&
        /[\uDC00-\uDFFF]/.test(text[boundary] ?? "")
      ) throw new Error("Token splits UTF-16 pair");
    }
    while (line + 1 < starts.length && starts[line + 1] <= from) line++;
    for (;;) {
      const start = Math.max(from, starts[line]),
        end = Math.min(to, ends[line]);
      if (end > start) {
        const column = start - starts[line];
        data.push(
          line - lastLine,
          line === lastLine ? column - lastColumn : column,
          end - start,
          kind,
          0,
        );
        lastLine = line;
        lastColumn = column;
      }
      if (line + 1 >= starts.length || starts[line + 1] >= to) break;
      line++;
    }
  }
  return new Uint32Array(data);
}
