import { createHash } from "node:crypto";
import { SDK_VERSION } from "../../../modules-sdk/js/mod.ts";
import {
  MAX_THEME_BYTES,
  type RegisteredTheme,
  validateTheme,
  validThemeIdentity,
} from "../../../modules-sdk/themes/mod.ts";

import {
  APP_METHODS,
  type AppCapability,
} from "../../../modules-sdk/js/app.ts";
export type Capability =
  | "log"
  | "tasks.progress"
  | "tasks.run-worker"
  | AppCapability
  | "process.execute";
import type { LanguageContribution } from "../../../modules-sdk/js/language.ts";
export type { LanguageContribution } from "../../../modules-sdk/js/language.ts";
export interface WasmTool {
  id: string;
  path: string;
  sha256: string;
  abi: "wasi-preview1";
  args: string[];
  /** Optional cooperative stdin extension for single-threaded guest schedulers. */
  stdin?: "cooperative-v1";
  assets?: string;
}
export interface ModuleManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  sdkVersion: typeof SDK_VERSION;
  runtime?: "deno" | "wasm";
  /** Absent means the native Component Model async ABI (SDK 0.1 default). */
  wasmProfile?: "async" | "sync";
  /** Bounded host resource policy; available to every kind of Wasm extension. */
  wasmResources?: "standard" | "compute";
  /** Opt-in: all disposable in-memory state can be reconstructed on activation. */
  lifecycle?: { idleUnload: boolean };
  entry?: string;
  capabilities: Capability[];
  /** Commands safe to execute in fresh isolated instances, with no shared state. */
  workers?: string[];
  wasmTools?: WasmTool[];
  contributions: {
    languages?: LanguageContribution[];
    commands: { id: string; title: string }[];
    themes: { id: string; label: string; path: string }[];
  };
}
export interface ModulePackage {
  readonly root: string;
  readonly entry?: string;
  readonly manifest: ModuleManifest;
  readonly themes: RegisteredTheme[];
}

function relativePath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 512 &&
    /^[A-Za-z0-9_./-]+$/.test(value) && !value.startsWith("/") &&
    value.split("/").every((part) => part && part !== "." && part !== "..");
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function validateManifest(value: unknown): ModuleManifest {
  if (
    !object(value) || value.schemaVersion !== 1 ||
    value.sdkVersion !== SDK_VERSION
  ) {
    throw new Error("Unsupported manifest schema or SDK version");
  }
  if (
    typeof value.id !== "string" ||
    !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(value.id)
  ) {
    throw new Error("Module ID must be publisher.name");
  }
  if (
    typeof value.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version)
  ) {
    throw new Error("Invalid module version");
  }
  if (
    value.runtime !== undefined && value.runtime !== "deno" &&
    value.runtime !== "wasm"
  ) {
    throw new Error("Unknown runtime");
  }
  if (
    value.wasmProfile !== undefined &&
    (value.runtime !== "wasm" ||
      (value.wasmProfile !== "async" && value.wasmProfile !== "sync"))
  ) throw new Error("Invalid Wasm profile");
  if (
    value.wasmResources !== undefined &&
    (value.runtime !== "wasm" ||
      !["standard", "compute"].includes(value.wasmResources as string))
  ) {
    throw new Error("Invalid Wasm resource profile");
  }
  if (
    value.lifecycle !== undefined &&
    (!value.runtime || !object(value.lifecycle) ||
      typeof value.lifecycle.idleUnload !== "boolean" ||
      Object.keys(value.lifecycle).some((key) => key !== "idleUnload"))
  ) {
    throw new Error("Invalid lifecycle policy");
  }
  if (
    value.runtime ? !relativePath(value.entry) : value.entry !== undefined
  ) {
    throw new Error("Entry must be a relative path inside the module");
  }
  const capabilities = value.capabilities ?? (value.runtime ? undefined : []);
  if (
    !Array.isArray(capabilities) ||
    capabilities.some((c) =>
      c !== "log" && c !== "tasks.progress" && c !== "tasks.run-worker" &&
      c !== "process.execute" &&
      !Object.values(APP_METHODS).includes(c)
    ) ||
    new Set(capabilities).size !== capabilities.length ||
    (!value.runtime && capabilities.length > 0)
  ) throw new Error("Invalid capabilities");
  if (value.wasmTools !== undefined) {
    if (
      !value.runtime || !Array.isArray(value.wasmTools) ||
      value.wasmTools.length > 2 ||
      !capabilities.includes("wasm.execute")
    ) throw new Error("Invalid packaged WASI tools");
    const toolIds = new Set<string>();
    for (const t of value.wasmTools) {
      if (
        !object(t) || typeof t.id !== "string" ||
        !/^[a-z][a-z0-9-]{0,63}$/.test(t.id) || toolIds.has(t.id) ||
        !relativePath(t.path) || !t.path.endsWith(".wasm") ||
        t.abi !== "wasi-preview1" ||
        typeof t.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(t.sha256) ||
        (t.assets !== undefined && !relativePath(t.assets)) ||
        (t.stdin !== undefined && t.stdin !== "cooperative-v1") ||
        !Array.isArray(t.args) || t.args.length > 32 || t.args.some((a) =>
          typeof a !== "string" || a.length > 512 || a.includes("\0")
        ) ||
        Object.keys(t).some((k) =>
          !["id", "path", "sha256", "abi", "args", "assets", "stdin"].includes(
            k,
          )
        )
      ) {
        throw new Error("Invalid packaged WASI tool");
      }
      toolIds.add(t.id);
    }
  }
  if (!object(value.contributions)) throw new Error("Expected contributions");
  const commands = value.contributions.commands ?? [];
  const themes = value.contributions.themes ?? [];
  if (
    !Array.isArray(commands) || commands.length > 128 ||
    (value.runtime ? commands.length === 0 : commands.length > 0)
  ) {
    throw new Error("Expected 1–128 commands");
  }
  const ids = new Set<string>();
  for (const command of commands) {
    if (
      !object(command) || typeof command.id !== "string" ||
      !command.id.startsWith(`${value.id}.`) ||
      !/^[a-zA-Z0-9.-]+$/.test(command.id) || command.id.length > 160 ||
      typeof command.title !== "string" || !command.title.trim() ||
      command.title.length > 160 || ids.has(command.id)
    ) {
      throw new Error("Invalid, duplicate, or foreign command ID");
    }
    ids.add(command.id);
  }
  if (
    value.workers !== undefined && (
      !value.runtime || !Array.isArray(value.workers) ||
      value.workers.length > 128 ||
      value.workers.some((id) => typeof id !== "string" || !ids.has(id)) ||
      new Set(value.workers).size !== value.workers.length
    )
  ) {
    throw new Error(
      "Workers must be distinct commands declared by this module",
    );
  }
  if (
    !Array.isArray(themes) || themes.length > 32 ||
    (!value.runtime && themes.length === 0)
  ) throw new Error("Expected 1–32 themes for a data-only module");
  for (const theme of themes) {
    if (
      !object(theme) || !validThemeIdentity(value.id, theme.id, theme.label) ||
      !relativePath(theme.path) || ids.has(theme.id as string)
    ) {
      throw new Error("Invalid, duplicate, or foreign theme contribution");
    }
    ids.add(theme.id as string);
  }
  const languages = value.contributions.languages ?? [];
  if (
    !Array.isArray(languages) || languages.length > 16 ||
    (!value.runtime && languages.length)
  ) {
    throw new Error("Invalid language contributions");
  }
  const languageIds = new Set<string>();
  for (const language of languages) {
    if (
      !object(language) ||
      !((language.protocol === 1 && language.scope === "document") ||
        (language.protocol === 2 && language.scope === "project")) ||
      typeof language.id !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(language.id) ||
      ["markdown", "json", "plaintext"].includes(language.id) ||
      languageIds.has(language.id) ||
      typeof language.name !== "string" || !language.name.trim() ||
      language.name.length > 80 ||
      !Array.isArray(language.extensions) || !language.extensions.length ||
      language.extensions.length > 16 ||
      language.extensions.some((e) =>
        typeof e !== "string" || !/^\.[a-zA-Z0-9_+-]{1,20}$/.test(e) ||
        [".md", ".json"].includes(e.toLowerCase())
      ) ||
      typeof language.command !== "string" || !commands.some((c) =>
        c.id === language.command
      ) ||
      !Array.isArray(language.features) || !language.features.length ||
      new Set(language.features).size !== language.features.length ||
      language.features.some((f) =>
        ![
          "completion",
          "hover",
          "definition",
          "diagnostics",
          "semanticTokens",
          "formatting",
          ...(language.protocol === 2 ? ["references", "rename"] : []),
        ]
          .includes(f)
      ) ||
      !capabilities.includes("documents.read") ||
      (language.protocol === 2 && !capabilities.includes("files.read")) ||
      Object.keys(language).some((key) =>
        ![
          "id",
          "name",
          "extensions",
          "command",
          "protocol",
          "scope",
          "features",
        ].includes(key)
      )
    ) {
      throw new Error(
        "Invalid language provider; declare documents.read and a local command",
      );
    }
    languageIds.add(language.id);
  }
  return structuredClone({
    ...value,
    capabilities,
    contributions: {
      commands,
      themes,
      ...(languages.length ? { languages } : {}),
    },
  }) as unknown as ModuleManifest;
}

export async function loadPackage(directory: string): Promise<ModulePackage> {
  const root = await Deno.realPath(directory);
  const separator = Deno.build.os === "windows" ? "\\" : "/";
  const inside = (path: string) => path.startsWith(`${root}${separator}`);
  async function readJson(path: string, limit: number): Promise<unknown> {
    const resolved = await Deno.realPath(`${root}/${path}`);
    if (!inside(resolved)) {
      throw new Error("Package file escapes module directory");
    }
    const file = await Deno.open(resolved);
    try {
      const stat = await file.stat();
      if (!stat.isFile || stat.size > limit) {
        throw new Error("Package JSON is not a file or is too large");
      }
      const bytes = new Uint8Array(limit + 1);
      let size = 0;
      while (size < bytes.length) {
        const count = await file.read(bytes.subarray(size));
        if (count === null) break;
        size += count;
      }
      if (size > limit) throw new Error("Package JSON is too large");
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, size),
        ),
      );
    } finally {
      file.close();
    }
  }
  const manifest = validateManifest(
    await readJson("maghemite.module.json", 64 * 1024),
  );
  let entry: string | undefined;
  if (manifest.runtime) {
    entry = await Deno.realPath(`${root}/${manifest.entry}`);
    if (!inside(entry) || !(await Deno.stat(entry)).isFile) {
      throw new Error("Entry escapes module directory or is not a file");
    }
    if (
      manifest.runtime === "wasm" &&
      (await Deno.stat(entry)).size > 64 * 1024 * 1024
    ) {
      throw new Error("Component exceeds 64 MiB");
    }
  }
  for (const tool of manifest.wasmTools ?? []) {
    await resolveWasmTool(root, tool);
  }
  const themes: RegisteredTheme[] = [];
  for (const contribution of manifest.contributions.themes) {
    themes.push({
      moduleId: manifest.id,
      id: contribution.id,
      label: contribution.label,
      theme: validateTheme(await readJson(contribution.path, MAX_THEME_BYTES)),
    });
  }
  return { root, entry, manifest, themes };
}

/** Validate binaries during installation and again immediately before starting. */
export async function resolveWasmTool(root: string, tool: WasmTool) {
  const inside = async (relative: string) => {
    const path = await Deno.realPath(`${root}/${relative}`);
    const separator = Deno.build.os === "windows" ? "\\" : "/";
    if (!path.startsWith(root + separator)) {
      throw new Error("WASI path escapes package");
    }
    return path;
  };
  const path = await inside(tool.path);
  const file = await Deno.open(path);
  const hash = createHash("sha256");
  const header = new Uint8Array(8);
  try {
    const stat = await file.stat();
    if (!stat.isFile || stat.size < 8 || stat.size > 128 * 1024 * 1024) {
      throw new Error("Invalid WASI tool size");
    }
    // Verify every launch, with fixed working memory even for a 128 MiB engine.
    // Incremental hashing also avoids WebCrypto's full input copy.
    const chunk = new Uint8Array(256 * 1024);
    let count = 0;
    while (count < stat.size) {
      const n = await file.read(
        chunk.subarray(0, Math.min(chunk.length, stat.size - count)),
      );
      if (n === null) throw new Error("Truncated WASI tool");
      if (count < header.length) {
        header.set(
          chunk.subarray(0, Math.min(n, header.length - count)),
          count,
        );
      }
      hash.update(chunk.subarray(0, n));
      count += n;
    }
    if (await file.read(chunk.subarray(0, 1)) !== null) {
      throw new Error("WASI tool changed during read");
    }
  } finally {
    file.close();
  }
  if (
    hash.digest("hex") !== tool.sha256 ||
    header.join() !== "0,97,115,109,1,0,0,0"
  ) throw new Error("WASI tool checksum or ABI mismatch");
  const assets = tool.assets ? await inside(tool.assets) : "";
  if (assets && !(await Deno.stat(assets)).isDirectory) {
    throw new Error("Invalid WASI assets");
  }
  return { path, assets };
}
