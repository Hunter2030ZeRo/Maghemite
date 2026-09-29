import { type AppMethod, createAppAPI } from "../../../modules-sdk/js/app.ts";
import type { Json } from "../../../modules-sdk/js/mod.ts";
import { createLinkResolver, type WorkspaceDocument } from "./model.ts";

interface CodeWorkspace {
  readonly state: { readonly documents: readonly WorkspaceDocument[] };
  request(method: string, parameters?: Json): Promise<Json>;
  openFile(path: string): Promise<void>;
  readonly application: {
    documentVersion(id: string): string;
    invoke(method: AppMethod, parameters: Record<string, Json>, owner: string): Json;
  };
}

export type CodeSymbol = {
  readonly path: string;
  readonly name: string;
  readonly kind: string;
  readonly container: string;
  readonly version: string;
  readonly line: number;
  readonly startByte: number;
  readonly endByte: number;
};
export type SymbolAnchor = Omit<CodeSymbol, "path" | "startByte" | "endByte">;
export type CodeEdge = {
  readonly source: string;
  readonly target: string;
  readonly line: number;
  readonly symbol: SymbolAnchor;
};
export class CodeLinkError extends Error {
  constructor(message: string) { super(message); this.name = "CodeLinkError"; }
}
const versionPattern = /^[a-f0-9]{64}$/;
const encode = (text: string) => encodeURIComponent(text).replace(/[!'()*]/g,
  (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

export function symbolFragment(symbol: SymbolAnchor) {
  return `symbol:${encode(JSON.stringify([
    1, symbol.kind, symbol.container, symbol.name, symbol.version, symbol.line,
  ]))}`;
}
/** The Markdown boundary has already decoded the URI fragment exactly once. */
export function parseSymbolFragment(fragment: string): SymbolAnchor | undefined {
  if (!fragment.startsWith("symbol:")) return;
  let value: unknown;
  try { value = JSON.parse(fragment.slice(7)); } catch { return; }
  if (!Array.isArray(value) || value.length !== 6 || value[0] !== 1 ||
    typeof value[1] !== "string" || !value[1] || value[1].length > 128 ||
    typeof value[2] !== "string" || value[2].length > 512 ||
    typeof value[3] !== "string" || !value[3] || value[3].length > 512 ||
    typeof value[4] !== "string" || !versionPattern.test(value[4]) ||
    !Number.isSafeInteger(value[5]) || value[5] < 1) return;
  return { kind: value[1], container: value[2], name: value[3], version: value[4], line: value[5] };
}
export function symbolMarkdown(symbol: CodeSymbol) {
  const label = (symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name)
    .replace(/([\\[\]])/g, "\\$1");
  const path = symbol.path.split("/").map(encode).join("/");
  const target = `/${path}#${symbolFragment(symbol)}`;
  if (target.length > 1024) {
    throw new CodeLinkError("This symbol link exceeds the indexer's 1024-byte target limit.");
  }
  return `[${label}](<${target}>)`;
}
export function codeEdges(
  links: readonly { source: string; target: string; line: number }[],
  paths: readonly string[],
): CodeEdge[] {
  const resolve = createLinkResolver(paths.map((path) => ({ path })));
  const result: CodeEdge[] = [];
  for (const link of links) {
    const target = link.target.split("|")[0], hash = target.indexOf("#");
    if (hash < 0) continue;
    let fragment: string;
    try { fragment = decodeURIComponent(target.slice(hash + 1)); } catch { continue; }
    const symbol = parseSymbolFragment(fragment);
    const file = symbol && resolve(target.slice(0, hash), { path: link.source });
    if (symbol && file) result.push({ source: link.source, target: file.path, line: link.line, symbol });
  }
  return result;
}
export function parseCodeSymbol(value: unknown): CodeSymbol | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  if (!("path" in value) || typeof value.path !== "string" ||
    !("name" in value) || typeof value.name !== "string" ||
    !("kind" in value) || typeof value.kind !== "string" ||
    !("container" in value) || (value.container !== null && typeof value.container !== "string") ||
    !("version" in value) || typeof value.version !== "string" || !versionPattern.test(value.version) ||
    !("line" in value) || typeof value.line !== "number" || !Number.isSafeInteger(value.line) ||
    !("startByte" in value) || typeof value.startByte !== "number" || !Number.isSafeInteger(value.startByte) ||
    !("endByte" in value) || typeof value.endByte !== "number" || !Number.isSafeInteger(value.endByte) ||
    value.line < 1 || value.startByte < 0 || value.endByte < value.startByte) return;
  return {
    path: value.path, name: value.name, kind: value.kind,
    container: typeof value.container === "string" ? value.container : "",
    version: value.version, line: value.line, startByte: value.startByte, endByte: value.endByte,
  };
}
export function selectCodeSymbol(symbols: readonly CodeSymbol[], anchor: SymbolAnchor) {
  const matches = symbols.filter((symbol) => symbol.name === anchor.name &&
    symbol.kind === anchor.kind && symbol.container === anchor.container);
  if (matches.length === 1) return matches[0];
  const exact = matches.filter((symbol) => symbol.version === anchor.version && symbol.line === anchor.line);
  if (exact.length === 1) return exact[0];
  if (!matches.length) {
    const renamed = symbols.filter((symbol) => symbol.kind === anchor.kind &&
      symbol.container === anchor.container && symbol.line === anchor.line);
    if (renamed.length === 1) return renamed[0];
  }
  throw new CodeLinkError(matches.length
    ? "This symbol link is ambiguous after a file change. Choose the symbol again in the outline."
    : "The linked symbol no longer exists. Choose a replacement in the outline.");
}
export function symbolRange(symbol: CodeSymbol, text: string, diskVersion?: string) {
  if (diskVersion !== symbol.version) throw new CodeLinkError("The symbol index is stale. Refresh it before navigating.");
  const bytes = new TextEncoder().encode(text), decoder = new TextDecoder("utf-8", { fatal: true });
  if (symbol.endByte > bytes.length) throw new CodeLinkError("The indexed symbol range is stale.");
  const name = decoder.decode(bytes.subarray(symbol.startByte, symbol.endByte));
  if (name !== symbol.name) throw new CodeLinkError("The indexed symbol no longer matches this file.");
  const from = decoder.decode(bytes.subarray(0, symbol.startByte)).length;
  return { from, to: from + name.length };
}
export async function indexedCodeSymbols(w: CodeWorkspace, path: string) {
  const api = createAppAPI(w.request), symbols: CodeSymbol[] = [];
  let offset = 0, revision: string | undefined;
  for (;;) {
    const page = await api.index.query({ kind: "symbols", path, offset });
    if (revision !== undefined && revision !== page.revision) {
      throw new CodeLinkError("The index changed while loading symbols. Refresh the outline.");
    }
    revision = page.revision;
    for (const item of page.items) {
      const symbol = parseCodeSymbol(item);
      if (symbol) symbols.push(symbol);
    }
    if (page.nextOffset === null) return symbols;
    if (symbols.length >= 1000 || page.nextOffset >= 1000) {
      throw new CodeLinkError("Symbol linking supports up to 1,000 indexed symbols per file.");
    }
    offset = page.nextOffset;
  }
}
export async function openCodeSymbol(w: CodeWorkspace, path: string, fragment: string) {
  const anchor = parseSymbolFragment(fragment);
  if (!anchor) throw new CodeLinkError("Invalid code symbol link.");
  const symbol = selectCodeSymbol(await indexedCodeSymbols(w, path), anchor);
  await w.openFile(path);
  const doc = w.state.documents.find((document) => document.path === path);
  if (!doc || doc.content !== doc.savedContent) {
    throw new CodeLinkError("Save or reload this file before resolving its indexed symbol.");
  }
  const range = symbolRange(symbol, doc.content, doc.diskVersion);
  w.application.invoke("editor.setSelection", {
    id: doc.id, version: w.application.documentVersion(doc.id),
    anchor: range.from, head: range.to,
  }, "maghemite.workbench");
}
