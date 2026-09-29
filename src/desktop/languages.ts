import { LanguageQueue } from "./language_queue.ts";
import { ProjectLanguages, type LanguageProjectAccess } from "./project_languages.ts";
import { projectBoundary } from "../../modules-sdk/js/project.ts";
import type { Json } from "../../modules-sdk/js/mod.ts";
import type { ModuleHost } from "../modules/host/host.ts";
import {
  LANGUAGE_TOKEN_PAGE,
  languageTokenTypes,
} from "../../modules-sdk/js/language.ts";

/** Command-backed, transport-independent providers. No external processes or tool paths. */
export class WorkbenchLanguages {
  #queues = new Map<string, LanguageQueue>();
  #sources = new Map<string, string>();
  readonly projects = new ProjectLanguages();
  clear() {
    this.projects.clear();
    this.#sources.clear();
    for (const queue of this.#queues.values()) queue.clear();
  }
  async request(
    host: ModuleHost,
    path: string,
    p: Record<string, Json>,
    snapshot: () => Promise<string>,
    signal: AbortSignal,
    project?: LanguageProjectAccess,
  ): Promise<Json> {
    const provider = host.languageProvider(path);
    if (!provider) return null;
    if (!provider.allowed) {
      throw new Error(
        "Allow this language module's required permissions in Modules (documents.read; files.read for project providers; wasm.execute for packaged WASI tools)",
      );
    }
    if (p.method === "status") {
      host.keepLanguageActive(path, provider.registration);
      return provider;
    }
    if (
      typeof p.version !== "string" || !p.version || p.version.length > 128 ||
      !provider.language.features.includes(p.method as never)
    ) throw new Error("Invalid language request");
    if (p.method === "rename" &&
      (typeof p.newName !== "string" || !p.newName || p.newName.length > 512 ||
        /[\0\r\n]/.test(p.newName))) {
      throw new Error("Enter a non-empty rename value of at most 512 characters");
    }
    if (p.includeDeclaration !== undefined && typeof p.includeDeclaration !== "boolean") {
      throw new Error("Invalid references declaration option");
    }
    if (provider.language.protocol === 2 && !project) {
      throw new Error("Project language context is unavailable");
    }
    const tokenStart = p.start ?? 0;
    if (
      p.method === "semanticTokens" && (typeof tokenStart !== "number" ||
        !Number.isSafeInteger(tokenStart) || tokenStart < 0 ||
        tokenStart > 128 * 1024)
    ) {
      throw new Error("Invalid language token cursor");
    }
    let queue = this.#queues.get(provider.moduleId);
    if (!queue) {
      this.#queues.set(provider.moduleId, queue = new LanguageQueue());
    }
    return await queue.enqueue(
      `${path}\0${p.method}`,
      ["hover", "completion", "definition", "references", "rename", "formatting"].includes(
        String(p.method),
      ),
      signal,
      async () => {
        signal.throwIfAborted();
        const context = provider.language.protocol === 2 ? await project!.context() : undefined;
        const key = `${path}\0${p.version}`;
        let text = this.#sources.get(key);
        if (text === undefined) {
          text = await snapshot();
          if (new TextEncoder().encode(text).length > 128 * 1024) {
            throw new Error("Language preview supports files up to 128 KiB");
          }
          while (this.#sources.size >= 4) {
            this.#sources.delete(this.#sources.keys().next().value!);
          }
          this.#sources.set(key, text);
        }
        if (
          !["diagnostics", "semanticTokens", "formatting"].includes(
            String(p.method),
          ) &&
          (typeof p.offset !== "number" ||
            !Number.isSafeInteger(p.offset) || p.offset < 0 ||
            p.offset > text.length ||
            (p.offset > 0 && /[\uD800-\uDBFF]/.test(text[p.offset - 1]) &&
              /[\uDC00-\uDFFF]/.test(text[p.offset] ?? "")))
        ) {
          throw new Error("Invalid UTF-16 language position");
        }
        const call = (input: Json) =>
          host.executeLanguage(path, provider.registration, input, {
            signal,
            timeoutMs: 30000,
          });
        if (context && typeof p.offset === "number") projectBoundary(text, p.offset);
        // The guest confirms its own snapshot on every transaction, including after idle restart.
        const state = await call({ op: "begin", path, version: p.version });
        if (
          !state || typeof state !== "object" || Array.isArray(state) ||
          state.synchronized !== true
        ) {
          let bytes = 0;
          for (let offset = 0; offset < text.length;) {
            let end = Math.min(offset + 4096, text.length);
            if (
              end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])
            ) end--;
            const chunk = text.slice(offset, end);
            await call({ op: "append", offset: bytes, text: chunk });
            bytes += new TextEncoder().encode(chunk).length;
            offset = end;
          }
          await call({ op: "commit" });
        }
        const result = await call({
          op: "query",
          path,
          version: p.version,
          method: p.method,
          ...(p.offset === undefined ? {} : { offset: p.offset }),
          ...(p.method === "semanticTokens" ? { start: tokenStart } : {}),
          ...(context ? { project: context } : {}),
          ...(p.method === "rename" ? { newName: p.newName } : {}),
          ...(p.method === "references" ? { includeDeclaration: p.includeDeclaration ?? true } : {}),
        });
        const validate = (result: Json) => validateLanguageResult(
          String(p.method), result, text.length, path, Number(tokenStart), text,
          provider.language.protocol === 2,
        );
        const checked = context && project
          ? await this.projects.accept(
            result, String(p.method), path, String(p.version),
            provider.registration, context, project, signal, validate,
          )
          : (validate(result), result);
        signal.throwIfAborted();
        const active = host.languageProvider(path);
        if (
          !active || active.registration !== provider.registration ||
          !active.allowed
        ) throw new Error("Language provider changed");
        return { provider: active, result: checked };
      },
    );
  }
}
function object(value: Json): Record<string, Json> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid language result");
  }
  return value;
}
export function validateLanguageResult(
  method: string,
  result: Json,
  length: number,
  path: string,
  tokenStart = 0,
  source?: string,
  project = false,
) {
  const range = (value: Json) => {
    const r = object(value);
    if (
      typeof r.from !== "number" || typeof r.to !== "number" ||
      !Number.isSafeInteger(r.from) ||
      !Number.isSafeInteger(r.to) || r.from < 0 || r.to < r.from ||
      r.to > length
    ) throw new Error("Invalid language result range");
  };
  const string = (value: Json, max: number) => {
    if (typeof value !== "string" || value.length > max) {
      throw new Error("Invalid language result text");
    }
  };
  if (method === "semanticTokens") {
    const page = object(result);
    if (
      !Array.isArray(page.tokens) || page.tokens.length > LANGUAGE_TOKEN_PAGE ||
      (page.next !== null &&
        (typeof page.next !== "number" || !Number.isSafeInteger(page.next) ||
          page.next <= tokenStart || page.next > length))
    ) {
      throw new Error("Invalid language token page");
    }
    let previous = tokenStart;
    for (const token of page.tokens) {
      if (
        !Array.isArray(token) || token.length !== 3 ||
        !token.every((v) => typeof v === "number" && Number.isSafeInteger(v)) ||
        Number(token[0]) < previous || Number(token[1]) <= Number(token[0]) ||
        Number(token[1]) > (page.next === null ? length : Number(page.next)) ||
        Number(token[2]) < 0 || Number(token[2]) >= languageTokenTypes.length
      ) {
        throw new Error("Invalid language token range or type");
      }
      for (const offset of token.slice(0, 2) as number[]) {
        if (
          source && /[\uD800-\uDBFF]/.test(source[offset - 1] ?? "") &&
          /[\uDC00-\uDFFF]/.test(source[offset] ?? "")
        ) throw new Error("Token splits UTF-16 pair");
      }
      previous = Number(token[1]);
    }
    return;
  }
  if (result === null) return;
  if (method === "hover") {
    const item = object(result);
    range(item.range);
    string(item.text, 16000);
    return;
  }
  if (!Array.isArray(result) || result.length > 100) {
    throw new Error("Invalid language result list");
  }
  let previousEditEnd = 0;
  for (const value of result) {
    const item = object(value);
    range(item.range);
    if (method === "formatting") {
      const edit = object(item.range);
      if (Number(edit.from) < previousEditEnd) {
        throw new Error("Overlapping format edits");
      }
      previousEditEnd = Number(edit.to);
      string(item.text, 48000);
      for (const offset of [Number(edit.from), Number(edit.to)]) {
        if (
          source && /[\uD800-\uDBFF]/.test(source[offset - 1] ?? "") &&
          /[\uDC00-\uDFFF]/.test(source[offset] ?? "")
        ) {
          throw new Error("Format edit splits UTF-16 pair");
        }
      }
    } else if (method === "completion") {
      if (!project && item.additionalTextEdits !== undefined) {
        throw new Error("Completion additional edits require language protocol 2");
      }
      string(item.label, 512);
      string(item.insertText, 4096);
      string(item.detail, 2048);
      string(item.filterText, 512);
      if (item.kind !== undefined) string(item.kind, 64);
    } else if (method === "diagnostics") {
      string(item.message, 2048);
      if (!["error", "warning", "info"].includes(String(item.severity))) {
        throw new Error("Invalid diagnostic severity");
      }
    } else if (method === "definition" && (item.path !== path || item.proposal !== undefined)) {
      throw new Error(
        "Cross-document navigation is not supported by this protocol version",
      );
    }
  }
}
