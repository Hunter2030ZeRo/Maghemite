import type {
  SearchCalls,
  SearchMatch,
} from "../../../modules-sdk/js/search.ts";
import type { DocumentEdit } from "../../../modules-sdk/js/services.ts";

export type SearchOptions = SearchCalls["search.start"]["input"];
export type SearchSnapshot = {
  readonly id: string;
  readonly path: string;
  readonly version: string;
  readonly content: string;
};

export class SearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchError";
  }
}

export function searchExpression(options: SearchOptions): RegExp {
  if (!options.query) throw new SearchError("Enter text to search for.");
  const pattern = options.regex
    ? options.query.replaceAll("(?P<", "(?<")
    : options.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(pattern, options.caseSensitive ? "gmu" : "gimu");
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new SearchError(`Invalid search expression: ${error.message}`);
    }
    throw error;
  }
}

/** The workbench filter syntax is deliberately limited to *, ** and ?. */
export function searchPathMatches(path: string, patterns: readonly string[]) {
  for (const pattern of patterns) {
    if (/[[\]{}\\]/.test(pattern)) {
      throw new SearchError("File filters support *, ** and ? wildcards.");
    }
  }
  return patterns.some((pattern) => {
    let source = "";
    for (let i = 0; i < pattern.length; i++) {
      const char = pattern[i];
      if (char === "*" && pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          source += "(?:.*/)?";
          i++;
        } else source += ".*";
      } else if (char === "*") source += ".*";
      else if (char === "?") source += ".";
      else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${source}$`, "u").test(path);
  });
}

function expandReplacement(template: string, match: RegExpExecArray) {
  return template.replace(/\$\$|\$\{([^}]+)\}|\$([A-Za-z0-9_]+)/g,
    (token: string, braced: string | undefined, bare: string | undefined) => {
      if (token === "$$") return "$";
      const name = braced ?? bare ?? "";
      return /^\d+$/.test(name)
        ? match[Number(name)] ?? ""
        : match.groups?.[name] ?? "";
    });
}

export function searchDrafts(
  documents: readonly SearchSnapshot[],
  options: SearchOptions,
): { matches: SearchMatch[]; truncated: boolean } {
  const expression = searchExpression(options), matches: SearchMatch[] = [];
  const limit = options.maxResults ?? 1000;
  // Validate filters even when there are no open documents.
  searchPathMatches("", [...options.include ?? [], ...options.exclude ?? []]);
  for (const doc of documents) {
    if (
      (options.include?.length && !searchPathMatches(doc.path, options.include)) ||
      (options.exclude?.length && searchPathMatches(doc.path, options.exclude))
    ) continue;
    expression.lastIndex = 0;
    for (;;) {
      const match = expression.exec(doc.content);
      if (!match) break;
      if (matches.length === limit) return { matches, truncated: true };
      const from = match.index, to = from + match[0].length;
      const lineStart = from === 0 ? 0 : doc.content.lastIndexOf("\n", from - 1) + 1;
      const lineEnd = doc.content.indexOf("\n", to);
      const prefix = doc.content.slice(0, from);
      const line = prefix.split("\n").length;
      const selectedLines = match[0].split("\n");
      const context = doc.content.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
      const replacement = options.replacement === undefined
        ? null
        : options.regex
        ? expandReplacement(options.replacement, match)
        : options.replacement;
      matches.push({
        id: `draft:${doc.id}:${from}:${to}`,
        path: doc.path,
        version: doc.version,
        from,
        to,
        line,
        column: from - lineStart,
        endLine: line + selectedLines.length - 1,
        endColumn: selectedLines.length > 1
          ? selectedLines[selectedLines.length - 1].length
          : to - lineStart,
        text: context.slice(0, 500),
        textTruncated: context.length > 500,
        replacement: replacement?.slice(0, 4096) ?? null,
        replacementTruncated: replacement !== null && replacement.length > 4096,
      });
      if (match[0].length === 0) {
        const code = doc.content.codePointAt(expression.lastIndex);
        expression.lastIndex += code !== undefined && code > 0xffff ? 2 : 1;
      }
    }
  }
  return { matches, truncated: false };
}

export function draftReplacementEdits(
  selected: readonly SearchMatch[],
  snapshots: readonly SearchSnapshot[],
  version: (id: string) => string,
): DocumentEdit[] {
  if (selected.length > 32) {
    throw new SearchError("Select at most 32 draft matches per replacement.");
  }
  return selected.map((match) => {
    const snapshot = snapshots.find((doc) => doc.path === match.path);
    if (!snapshot || version(snapshot.id) !== match.version) {
      throw new SearchError(`Draft changed: ${match.path}. Search again.`);
    }
    if (match.replacement === null || match.replacementTruncated) {
      throw new SearchError("Search again with a complete replacement preview.");
    }
    return {
      id: snapshot.id,
      version: match.version,
      from: match.from,
      to: match.to,
      text: match.replacement,
    };
  });
}
