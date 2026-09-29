import MarkdownIt from "markdown-it";
import type { Env, StateInline, Token } from "markdown-it";
import { resolveLink } from "./model.ts";

export type MarkdownTarget =
  | { readonly kind: "external"; readonly href: string }
  | { readonly kind: "fragment"; readonly fragment: string }
  | {
    readonly kind: "workspace";
    readonly path: string;
    readonly fragment: string;
  }
  | { readonly kind: "blocked"; readonly reason: string };

export type MarkdownRenderOptions = {
  readonly documentId: string;
  readonly currentPath: string;
  readonly documents: readonly { readonly path: string }[];
};

type RenderEnvironment = Env & MarkdownRenderOptions & {
  blockedLinks?: boolean[];
};

const externalProtocol = /^(https?:|mailto:)/i;
const anyProtocol = /^[a-z][a-z0-9+.-]*:/i;

function normalizedPath(path: string): string | undefined {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return;
      parts.pop();
    } else {
      if (part.includes("\\") || part.includes("\0") || part.includes(":")) {
        return;
      }
      parts.push(part);
    }
  }
  return parts.join("/");
}

function decoded(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return;
  }
}

export function resolveMarkdownTarget(
  raw: string,
  currentPath: string,
): MarkdownTarget {
  const target = raw.trim();
  if (!target) return { kind: "blocked", reason: "Empty destination" };
  if (externalProtocol.test(target)) {
    try {
      const url = new URL(target);
      if (!externalProtocol.test(url.protocol)) {
        return { kind: "blocked", reason: "Unsupported URL protocol" };
      }
      return { kind: "external", href: url.href };
    } catch {
      return { kind: "blocked", reason: "Invalid external URL" };
    }
  }
  if (anyProtocol.test(target) || target.startsWith("//")) {
    return { kind: "blocked", reason: "Unsupported URL protocol" };
  }
  const hash = target.indexOf("#");
  const pathPart = hash < 0 ? target : target.slice(0, hash);
  const fragment = decoded(hash < 0 ? "" : target.slice(hash + 1));
  const path = decoded(pathPart);
  if (fragment === undefined || path === undefined || path.includes("?")) {
    return { kind: "blocked", reason: "Invalid workspace link" };
  }
  if (!path) return { kind: "fragment", fragment };
  const directory = currentPath.slice(0, currentPath.lastIndexOf("/") + 1);
  const normalized = normalizedPath(
    path.startsWith("/") ? path.slice(1) : `${directory}${path}`,
  );
  if (!normalized) {
    return { kind: "blocked", reason: "Path leaves the workspace" };
  }
  return { kind: "workspace", path: normalized, fragment };
}

export function headingSlug(text: string): string {
  return text.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-").replace(/-+/g, "-");
}

export function resolveWikiTarget(
  raw: string,
  options: Pick<MarkdownRenderOptions, "currentPath" | "documents">,
): MarkdownTarget {
  const target = raw.split("|", 1)[0].trim();
  const hash = target.indexOf("#");
  const note = hash < 0 ? target : target.slice(0, hash);
  const fragment = hash < 0 ? "" : target.slice(hash + 1);
  const existing = resolveLink(
    note,
    [...options.documents],
    { path: options.currentPath },
  );
  if (existing) {
    return {
      kind: "workspace",
      path: existing.path,
      fragment: decoded(fragment) ?? "",
    };
  }
  const extension = /\.mdx?$/i.test(note) ? note : `${note}.md`;
  return resolveMarkdownTarget(
    `${extension}${fragment ? `#${fragment}` : ""}`,
    options.currentPath,
  );
}

function wikiRule(state: StateInline, silent: boolean): boolean {
  if (state.src.slice(state.pos, state.pos + 2) !== "[[") return false;
  const end = state.src.indexOf("]]", state.pos + 2);
  if (end < 0 || state.src.slice(state.pos + 2, end).includes("\n")) {
    return false;
  }
  if (silent) return true;
  const raw = state.src.slice(state.pos + 2, end);
  const separator = raw.indexOf("|");
  const target = (separator < 0 ? raw : raw.slice(0, separator)).trim();
  if (!target) return false;
  const label = (separator < 0 ? target.split("#", 1)[0] : raw.slice(separator + 1))
    .trim() || target;
  const token = state.push("wiki_link", "a", 0);
  token.meta = { target, label };
  state.pos = end + 2;
  return true;
}

function taskLists(tokens: Token[], create: typeof MarkdownIt.Token): void {
  let item: Token | undefined;
  for (const token of tokens) {
    if (token.type === "list_item_open") item = token;
    if (token.type === "list_item_close") item = undefined;
    if (token.type !== "inline" || !item || !token.children?.length) continue;
    const first = token.children[0];
    const match = first?.type === "text"
      ? /^\[([ xX])\]\s+/.exec(first.content)
      : null;
    if (!match) continue;
    first.content = first.content.slice(match[0].length);
    const checkbox = new create("task_checkbox", "input", 0);
    checkbox.meta = { checked: match[1].toLowerCase() === "x" };
    token.children.unshift(checkbox);
    item.attrJoin("class", "task-list-item");
  }
}

const parser = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  maxNesting: 64,
});
parser.inline.ruler.before("link", "wiki_link", wikiRule);
parser.core.ruler.after("inline", "task_lists", (state) => {
  taskLists(state.tokens, state.Token);
});
parser.renderer.rules.task_checkbox = (tokens, index) =>
  `<input class="task-checkbox" type="checkbox" disabled${
    tokens[index].meta?.checked === true ? " checked" : ""
  } aria-label="Task">`;
parser.renderer.rules.wiki_link = (tokens, index, _options, env) => {
  const meta = tokens[index].meta;
  const target = typeof meta?.target === "string" ? meta.target : "";
  const label = typeof meta?.label === "string" ? meta.label : target;
  const resolved = resolveWikiTarget(target, env as RenderEnvironment);
  if (resolved.kind !== "workspace") {
    const reason = resolved.kind === "blocked"
      ? resolved.reason
      : "Wiki links must target workspace notes";
    return `<span class="markdown-unsafe-link" title="${
      parser.utils.escapeHtml(reason)
    }">${parser.utils.escapeHtml(label)}</span>`;
  }
  return `<a class="wiki-link" href="#" data-workspace-link="${
    parser.utils.escapeHtml(resolved.path)
  }" data-note-fragment="${
    parser.utils.escapeHtml(resolved.fragment)
  }">${parser.utils.escapeHtml(label)}</a>`;
};
parser.renderer.rules.heading_open = (tokens, index, options, env, renderer) => {
  const token = tokens[index], line = (token.map?.[0] ?? 0) + 1;
  const next = tokens[index + 1];
  const text = next?.type === "inline" ? next.content : "";
  token.attrSet(
    "id",
    `${encodeURIComponent((env as RenderEnvironment).documentId)}-heading-${line}`,
  );
  token.attrSet("data-line", line);
  token.attrSet("data-heading-slug", headingSlug(text));
  return renderer.renderToken(tokens, index, options);
};
parser.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  const result = resolveMarkdownTarget(
    String(token.attrGet("href") ?? ""),
    (env as RenderEnvironment).currentPath,
  );
  const stack = ((env as RenderEnvironment).blockedLinks ??= []);
  stack.push(result.kind === "blocked");
  if (result.kind === "blocked") {
    return `<span class="markdown-unsafe-link" title="${
      parser.utils.escapeHtml(result.reason)
    }">`;
  }
  if (result.kind === "external") {
    token.attrSet("href", result.href);
    token.attrSet("rel", "noreferrer noopener");
    if (result.href.startsWith("http")) token.attrSet("target", "_blank");
  } else {
    token.attrSet("href", "#");
    if (result.kind === "workspace") {
      token.attrSet("data-workspace-link", result.path);
      token.attrSet("data-note-fragment", result.fragment);
    } else token.attrSet("data-note-fragment", result.fragment);
  }
  return renderer.renderToken(tokens, index, options);
};
parser.renderer.rules.link_close = (_tokens, _index, _options, env) =>
  (env as RenderEnvironment).blockedLinks?.pop() ? "</span>" : "</a>";
parser.renderer.rules.image = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  const source = resolveMarkdownTarget(
    String(token.attrGet("src") ?? ""),
    (env as RenderEnvironment).currentPath,
  );
  const alt = renderer.renderInlineAsText(token.children ?? [], options, env);
  if (source.kind !== "workspace") {
    const reason = source.kind === "external"
      ? "Remote image blocked"
      : source.kind === "fragment"
      ? "Invalid image path"
      : source.reason;
    return `<span class="markdown-image-blocked">${
      parser.utils.escapeHtml(`${reason}: ${alt || "image"}`)
    }</span>`;
  }
  return `<img data-attachment="${parser.utils.escapeHtml(source.path)}" alt="${
    parser.utils.escapeHtml(alt)
  }" loading="lazy">`;
};

export function renderMarkdown(
  source: string,
  options: MarkdownRenderOptions,
): string {
  const env: RenderEnvironment = { ...options, blockedLinks: [] };
  const tokens = parser.parse(source, env);
  return parser.renderer.render(tokens, parser.options, env);
}
