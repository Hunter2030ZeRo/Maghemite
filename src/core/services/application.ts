import { basename, isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { SERVICE_METHODS } from "../../../modules-sdk/js/services.ts";
import type { AppMethod } from "../../../modules-sdk/js/app.ts";
import type { Json } from "../../../modules-sdk/js/mod.ts";
import type {
  ApplicationCaller,
  ApplicationServices,
} from "../../modules/host/application.ts";
import {
  applicationResources,
  type ResourceAdmission,
} from "../../modules/host/resources.ts";
import { CoreBridge } from "../../native/core.ts";
import { WorkspaceIndexService } from "../workspace/filesystem/indexer.ts";
import { EventHub } from "./events.ts";
import { SettingsStore } from "./settings.ts";
import {
  OwnedProcess,
  type ProcessReservation,
  ProtocolSession,
  type ToolProfile,
  ToolSession,
  validateProfiles,
} from "./processes.ts";
import {
  applicationPathsOverlap,
  applicationPrivateStorageRoots,
  canonicalApplicationPath,
} from "../../shared/application_paths.ts";

export interface NativeOptions {
  root?: string;
  dataDirectory: string;
  /** Additional app-owned roots registered before the first workspace opens. */
  protectedRoots?: readonly string[];
  coreLibrary: string;
  profiles?: ToolProfile[];
  ptyLibrary?: string;
  /** Trusted injection seam; defaults to the controller shared by ModuleHost. */
  resources?: ResourceAdmission;
}
const PROCESS_RESERVATION_BYTES = 512 * 1024 * 1024;
const NATIVE_PREFIXES = [
  "search.",
  "files.",
  "index.",
  "settings.",
  "storage.",
  "events.",
  "terminal.",
  "tools.",
  "formatting.",
  "linting.",
  "language.",
  "debug.",
];
/** All ambient OS access lives in this trusted host. Guests only receive owned handles. */
export class NativeApplicationServices implements ApplicationServices {
  readonly events = new EventHub();
  readonly sessions = new Map<string, OwnedProcess>();
  readonly settings: SettingsStore;
  readonly profiles: ToolProfile[];
  readonly resources: ResourceAdmission;
  workspace?: WorkspaceIndexService;
  core?: CoreBridge;
  #status: Json = { phase: "queued" };
  #closed = false;
  #changing = false;
  #preparing = false;
  #inflight = new Map<Promise<unknown>, string>();
  #owners = new Set<string>();
  #releasing = new Set<string>();
  #admissions = new Map<string, Set<AbortController>>();
  #languageDocuments = new Map<string, Map<string, number>>();
  private constructor(readonly options: NativeOptions) {
    this.profiles = validateProfiles(options.profiles ?? []);
    this.settings = new SettingsStore(join(options.dataDirectory, "modules"));
    this.resources = options.resources ?? applicationResources;
  }
  static async open(options: NativeOptions) {
    await Deno.mkdir(options.dataDirectory, { recursive: true, mode: 0o700 });
    const dataDirectory = await Deno.realPath(options.dataDirectory);
    const protectedRoots = await Promise.all(
      [
        ...applicationPrivateStorageRoots(dataDirectory),
        ...options.protectedRoots ?? [],
      ].map(canonicalApplicationPath),
    );
    const service = new NativeApplicationServices({
      ...options,
      root: undefined,
      dataDirectory,
      protectedRoots,
    });
    if (options.root) {
      try {
        const prepared = await service.prepareWorkspace(options.root);
        await prepared!.commit();
      } catch (error) {
        await service.close();
        throw error;
      }
    }
    return service;
  }
  /** Stage a new watcher/index on the SAME bridge: closing a bridge shuts down Rust globally. */
  async prepareWorkspace(path: string) {
    if (this.#closed || this.#preparing) {
      throw new Error("A folder change is already in progress");
    }
    this.#preparing = true;
    let candidate: WorkspaceIndexService | undefined;
    try {
      const root = await Deno.realPath(path);
      if (!(await Deno.stat(root)).isDirectory) {
        throw new Error("Choose a directory, not a file");
      }
      const suffix = relative(root, this.options.dataDirectory);
      if (
        suffix === "" ||
        (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith("../") &&
          !suffix.startsWith("..\\"))
      ) {
        throw new Error(
          "Application data directory must be outside the workspace",
        );
      }
      for (const protectedRoot of this.options.protectedRoots ?? []) {
        if (
          applicationPathsOverlap(
            root,
            await canonicalApplicationPath(protectedRoot),
          )
        ) {
          throw new Error(
            "Private application storage must be outside the workspace",
          );
        }
      }
      // Check listing permission before disturbing the currently open folder.
      for await (const _entry of Deno.readDir(root)) break;
      if (root === this.workspace?.root) {
        this.#preparing = false;
        return null;
      }
      this.core ??= CoreBridge.open(this.options.coreLibrary);
      let status: Json = { phase: "queued" };
      const update = (next: Json) => {
        status = next;
        if (this.workspace === candidate) {
          this.#status = next;
          this.events.emit("index.changed", next);
        }
      };
      candidate = await WorkspaceIndexService.open(this.core, root, {
        dataDirectory: this.options.dataDirectory,
        onStatus: (value) =>
          update(
            JSON.parse(JSON.stringify(value, (_, v) =>
              typeof v === "bigint" ? String(v) : v)),
          ),
        onError: (error) => update({ phase: "failed", error: error.message }),
        onChange: (paths) => {
          if (this.workspace === candidate) {
            this.events.emit("files.changed", { paths });
          }
        },
      });
      let finished = false;
      return {
        root,
        commit: async () => {
          if (finished || this.#closed) {
            throw new Error("Folder change expired");
          }
          this.#changing = true;
          try {
            await Promise.all(
              [...this.#owners].map((owner) => this.release(owner)),
            );
            await this.workspace?.close();
            this.workspace = candidate;
            this.options.root = root;
            this.#status = status;
            finished = true;
          } finally {
            this.#changing = false;
            this.#preparing = false;
          }
        },
        abort: async () => {
          if (finished) return;
          finished = true;
          await candidate!.close();
          this.#preparing = false;
        },
      };
    } catch (error) {
      await candidate?.close();
      this.#preparing = false;
      throw error;
    }
  }
  methods(): AppMethod[] {
    return (Object.keys(SERVICE_METHODS) as AppMethod[]).filter((m) =>
      m === "workspace.roots" || NATIVE_PREFIXES.some((p) => m.startsWith(p))
    ).filter((m) =>
      this.workspace ||
      !(m.startsWith("files.") || m.startsWith("index.") || m.startsWith("search.") ||
        m.startsWith("terminal.") || m.startsWith("language.") ||
        m.startsWith("debug.") || m === "tools.start" ||
        m === "formatting.format" || m === "linting.lint")
    );
  }
  request(
    method: AppMethod,
    parameters: Json,
    caller: ApplicationCaller,
  ): Promise<Json> {
    return this.#track(
      caller.owner ?? caller.moduleId,
      () => this.#request(method, parameters, caller),
    );
  }
  #track(owner: string, run: () => Promise<Json>): Promise<Json> {
    if (this.#closed || this.#changing) {
      return Promise.reject(new Error("Native services closed"));
    }
    if (this.#releasing.has(owner)) {
      return Promise.reject(new Error("Module resources are closing"));
    }
    this.#owners.add(owner);
    const work = run();
    this.#inflight.set(work, owner);
    void work.finally(() => this.#inflight.delete(work)).catch(() => {});
    return work;
  }
  /** Trusted workbench entry point; the SDK continues to require configured tool profiles. */
  createWorkbenchTerminal(
    columns: number,
    rows: number,
    signal: AbortSignal,
  ): Promise<Json> {
    return this.#track("workbench", async () => {
      const { defaultShell } = await import("./shell.ts");
      return await this.#startTerminal(
        "workbench",
        await defaultShell(),
        columns,
        rows,
        signal,
        this.workspace?.root ?? Deno.env.get("HOME") ??
          Deno.env.get("USERPROFILE") ?? Deno.cwd(),
      );
    });
  }
  async #startTerminal(
    owner: string,
    profile: ToolProfile,
    columns: number,
    rows: number,
    signal: AbortSignal,
    cwd: string,
  ): Promise<Json> {
    if (
      !Number.isInteger(columns) || columns < 2 || columns > 500 ||
      !Number.isInteger(rows) || rows < 2 || rows > 300
    ) throw new Error("Invalid terminal dimensions");
    const { initializePty, TerminalSession } = await import("./pty.ts");
    await initializePty(this.options.ptyLibrary);
    const reservation = await this.#reserveProcess(owner, profile, signal);
    try {
      const session = new TerminalSession(
        owner,
        profile,
        cwd,
        columns,
        rows,
        this.events,
        reservation,
      );
      this.sessions.set(session.id, session);
      return { session: session.id, profile: profile.id };
    } catch (error) {
      reservation.release();
      throw error;
    }
  }
  #profile(id: string, kind: string) {
    const p = this.profiles.find((p) => p.id === id && p.kind === kind);
    if (!p) throw new Error(`No configured ${kind} profile: ${id}`);
    return p;
  }
  #limit(owner: string) {
    if (
      this.sessions.size >= 32 ||
      [...this.sessions.values()].filter((p) => p.owner === owner).length >= 8
    ) throw new Error("Process session limit reached");
  }
  #startAllowed(owner: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.#closed || this.#changing || this.#releasing.has(owner)) {
      throw new Error("Process resources are closing");
    }
    this.#limit(owner);
  }
  async #reserveProcess(
    owner: string,
    profile: ToolProfile,
    signal: AbortSignal,
  ): Promise<ProcessReservation> {
    this.#startAllowed(owner, signal);
    const closing = new AbortController();
    const admissions = this.#admissions.get(owner) ?? new Set();
    admissions.add(closing);
    this.#admissions.set(owner, admissions);
    const combined = AbortSignal.any([signal, closing.signal]);
    const usage = {
      id: `native.process:${crypto.randomUUID()}`,
      label: `${profile.kind} profile ${profile.id}`,
      pid: null,
      rssBytes: null,
      reservedBytes: PROCESS_RESERVATION_BYTES,
      diskBytes: null,
    };
    let lease: { release(): void } | undefined;
    try {
      lease = await this.resources.reserveHostUsage(usage, combined);
      this.#startAllowed(owner, combined);
    } catch (error) {
      lease?.release();
      throw error;
    } finally {
      admissions.delete(closing);
      if (!admissions.size) this.#admissions.delete(owner);
    }
    let active = true;
    return {
      started: (pid) => {
        if (!active) return;
        this.resources.reportHostUsage({ ...usage, pid });
      },
      release: () => {
        if (!active) return;
        active = false;
        lease.release();
      },
    };
  }
  #session(id: string, owner: string, kind: string) {
    const s = this.sessions.get(id);
    if (!s || s.owner !== owner || s.profile.kind !== kind) {
      throw new Error("Session not found or owned by another runtime");
    }
    return s;
  }
  #uri(path: string) {
    if (
      !path || path.includes("\\") || path.includes(":") ||
      path.startsWith("/") ||
      path.split("/").some((s) => !s || s === ".." || s === ".")
    ) throw new Error("Expected workspace-relative path");
    return pathToFileURL(join(this.workspace!.root, path)).href;
  }
  async #request(
    method: AppMethod,
    parameters: Json,
    caller: ApplicationCaller,
  ): Promise<Json> {
    caller.signal.throwIfAborted();
    const owner = caller.owner ?? caller.moduleId,
      p = parameters as Record<string, Json>;
    if (method === "workspace.roots") {
      return {
        roots: this.workspace
          ? [{ id: "workspace", label: basename(this.workspace.root) }]
          : [],
      };
    }
    if (method.startsWith("search.")) {
      if (!this.core || !this.workspace) {
        throw new Error("No disk workspace selected");
      }
      // Defense in depth for guests; the trusted workbench supplies no grants.
      if (caller.grants) {
        for (const permission of method === "search.replace"
          ? ["files.read", "files.write"]
          : ["files.read"]) {
          if (!caller.grants.has(permission)) {
            throw new Error(`Capability denied: ${permission}`);
          }
        }
      }
      const core = this.core, workspace = this.workspace.workspaceId;
      let cancellation: Promise<Json> | undefined;
      const abort = () => {
        if (typeof p.search === "string") {
          // Release can win this race; the owned handle is then already cleaned up.
          cancellation = core.request(workspace, "search.cancel", {
            search: p.search, owner,
          }).catch(() => null);
        }
      };
      caller.signal.addEventListener("abort", abort, { once: true });
      try {
        const result = await core.request(workspace, method, { ...p, owner });
        if (caller.signal.aborted && method === "search.start") {
          const handle = result && typeof result === "object" &&
              !Array.isArray(result)
            ? result.search
            : undefined;
          if (typeof handle === "string") {
            await core.request(workspace, "search.release", { search: handle, owner });
          }
        }
        caller.signal.throwIfAborted();
        return result;
      } finally {
        caller.signal.removeEventListener("abort", abort);
        await cancellation;
      }
    }
    if (method.startsWith("files.") || method === "index.query") {
      if (!this.core || !this.workspace) {
        throw new Error("No disk workspace selected");
      }
      if (
        caller.grants &&
        ["files.move", "files.trash", "files.trashList", "files.restoreTrash"]
          .includes(method)
      ) {
        const permission = method === "files.trashList" ? "files.read" : "files.write";
        if (!caller.grants.has(permission)) {
          throw new Error(`Capability denied: ${permission}`);
        }
      }
      const result = await this.core.request(
        this.workspace.workspaceId,
        method,
        { ...p, owner },
      );
      return result;
    }
    if (method === "index.status") return this.#status;
    if (method === "index.refresh") {
      this.workspace!.requestFullScan();
      return null;
    }
    if (method.startsWith("settings.") || method.startsWith("storage.")) {
      const [namespace, action] = method.split(".");
      const result = await this.settings.request(
        namespace as "settings" | "storage",
        action,
        caller.moduleId,
        p,
        caller.signal,
      );
      if (action === "set" || action === "delete") {
        this.events.emit(`${namespace}.changed`, { key: p.key }, owner);
      }
      return result;
    }
    if (method === "events.subscribe") {
      return this.events.subscribe(p.topics as string[], caller);
    }
    if (method === "events.next") {
      return await this.events.next(
        p.subscription as string,
        (p.waitMs as number) ?? 0,
        caller,
      );
    }
    if (method === "events.unsubscribe") {
      this.events.unsubscribe(p.subscription as string, owner);
      return null;
    }
    if (method === "tools.list") {
      return { profiles: this.profiles.map(({ id, kind }) => ({ id, kind })) };
    }
    if (method === "terminal.list") {
      return {
        sessions: [...this.sessions.values()].filter((s) =>
          s.owner === owner && s.profile.kind === "terminal"
        ).map((s) => ({ session: s.id, profile: s.profile.id })),
      };
    }
    if (method === "terminal.create") {
      if (!this.workspace) {
        throw new Error("Open a folder before creating a module terminal");
      }
      return await this.#startTerminal(
        owner,
        this.#profile(p.profile as string, "terminal"),
        (p.columns as number) ?? 80,
        (p.rows as number) ?? 24,
        caller.signal,
        this.workspace.root,
      );
    }

    if (method.startsWith("terminal.")) {
      const s = this.#session(
        p.session as string,
        owner,
        "terminal",
      ) as import("./pty.ts").TerminalSession;
      switch (method) {
        case "terminal.read":
          return s.read(p.cursor as number | undefined);
        case "terminal.write":
          s.write(p.text as string);
          return null;
        case "terminal.resize":
          s.resize(p.columns as number, p.rows as number);
          return null;
        case "terminal.close":
          this.sessions.delete(s.id);
          await s.close();
          return null;
      }
    }
    if (
      method === "tools.start" || method === "formatting.format" ||
      method === "linting.lint"
    ) {
      const kind = method === "tools.start"
        ? "tool"
        : method === "formatting.format"
        ? "formatter"
        : "linter";
      const profile = this.#profile(p.profile as string, kind);
      const reservation = await this.#reserveProcess(
        owner,
        profile,
        caller.signal,
      );
      let s: ToolSession;
      try {
        s = new ToolSession(
          owner,
          profile,
          this.workspace!.root,
          (p.input ?? p.text ?? "") as string,
          this.events,
          reservation,
        );
      } catch (error) {
        reservation.release();
        throw error;
      }
      this.sessions.set(s.id, s);
      if (method === "tools.start") return { session: s.id };
      const abort = () => {
        void s.close();
      };
      caller.signal.addEventListener("abort", abort, { once: true });
      try {
        const result = await s.result(caller.signal);
        if (!result.complete) {
          throw new Error("Tool output exceeded limit; result was truncated");
        }
        return result;
      } finally {
        caller.signal.removeEventListener("abort", abort);
        this.sessions.delete(s.id);
        await s.close();
      }
    }
    if (
      method === "tools.read" || method === "tools.result" ||
      method === "tools.cancel" || method === "tools.stop"
    ) {
      const s = this.#session(
        p.session as string,
        owner,
        "tool",
      ) as ToolSession;
      if (method === "tools.read") {
        return s.read(p.cursor as number | undefined);
      }
      if (method === "tools.result") {
        try {
          return await s.result(caller.signal);
        } finally {
          this.sessions.delete(s.id);
          await s.close();
        }
      }
      if (method === "tools.cancel") {
        await s.close();
        return null;
      }
      this.sessions.delete(s.id);
      await s.close();
      return null;
    }
    if (method.startsWith("language.") || method.startsWith("debug.")) {
      const [kind, action] = method.split(".");
      if (action === "start") {
        const profile = this.#profile(p.profile as string, kind);
        const reservation = await this.#reserveProcess(
          owner,
          profile,
          caller.signal,
        );
        let s: ProtocolSession;
        try {
          s = new ProtocolSession(
            owner,
            profile,
            this.workspace!.root,
            this.events,
            reservation,
          );
        } catch (error) {
          reservation.release();
          throw error;
        }
        this.sessions.set(s.id, s);
        try {
          const initialized = await s.request(
            "initialize",
            kind === "language"
              ? {
                processId: null,
                rootUri: pathToFileURL(this.workspace!.root).href,
                capabilities: {
                  general: { positionEncodings: ["utf-16"] },
                  textDocument: {
                    synchronization: { dynamicRegistration: false },
                  },
                },
                initializationOptions: p.options ?? null,
              }
              : {
                clientID: "maghemite",
                adapterID: p.profile,
                linesStartAt1: true,
                columnsStartAt1: true,
                pathFormat: "path",
                ...(p.options && typeof p.options === "object" &&
                    !Array.isArray(p.options)
                  ? p.options
                  : {}),
              },
            caller.signal,
          );
          const capabilities = kind === "language"
            ? (initialized as Record<string, Json>).capabilities ?? {}
            : initialized;
          if (kind === "language") {
            const encoding =
              (capabilities as Record<string, Json>).positionEncoding;
            if (encoding !== undefined && encoding !== "utf-16") {
              throw new Error(
                "Language server selected unsupported position encoding",
              );
            }
            await s.notify("initialized", {});
            this.#languageDocuments.set(s.id, new Map());
          }
          return { session: s.id, capabilities };
        } catch (e) {
          this.sessions.delete(s.id);
          await s.close();
          throw e;
        }
      }
      const s = this.#session(
        p.session as string,
        owner,
        kind,
      ) as ProtocolSession;
      if (action === "request") {
        return await s.request(p.method as string, p.parameters, caller.signal);
      }
      if (action === "respond") {
        await s.respond(
          p.requestId as string | number,
          p.result,
          p.error as string | undefined,
        );
        return null;
      }
      if (action === "read") return s.read(p.cursor as number | undefined);
      if (action === "stop") {
        this.sessions.delete(s.id);
        this.#languageDocuments.delete(s.id);
        await s.close();
        return null;
      }
      if (action === "notify") {
        await s.notify(p.method as string, p.parameters);
        return null;
      }
      const uri = this.#uri(p.path as string),
        docs = this.#languageDocuments.get(s.id)!;
      if (action === "sync") {
        const version = p.version as number, last = docs.get(uri);
        if (last !== undefined && version <= last) {
          throw new Error("Language document version conflict");
        }
        if (last === undefined && docs.size >= 100) {
          throw new Error("Language document limit reached");
        }
        await s.notify(
          last === undefined
            ? "textDocument/didOpen"
            : "textDocument/didChange",
          last === undefined
            ? {
              textDocument: {
                uri,
                languageId: p.languageId,
                version,
                text: p.text,
              },
            }
            : {
              textDocument: { uri, version },
              contentChanges: [{ text: p.text }],
            },
        );
        docs.set(uri, version);
        return null;
      }
      if (action === "closeDocument") {
        if (docs.has(uri)) {
          await s.notify("textDocument/didClose", { textDocument: { uri } });
          docs.delete(uri);
        }
        return null;
      }
    }
    throw new Error(`Native service unavailable: ${method}`);
  }
  async release(owner: string) {
    this.#releasing.add(owner);
    for (const admission of this.#admissions.get(owner) ?? []) {
      admission.abort(new DOMException("Process resources are closing", "AbortError"));
    }
    this.#admissions.delete(owner);
    // Wake native search reads and join workers before awaiting in-flight calls.
    if (this.workspace && this.core) {
      await this.core.request(this.workspace.workspaceId, "resources.release", { owner });
    }
    // The module host aborts the runtime before releasing it. Let pending native calls settle.
    this.events.release(owner);
    const closeSessions = () =>
      Promise.allSettled(
        [...this.sessions.values()].filter((s) => s.owner === owner).map(
          async (s) => {
            this.sessions.delete(s.id);
            this.#languageDocuments.delete(s.id);
            await s.close();
          },
        ),
      );
    await closeSessions();
    await Promise.allSettled(
      [...this.#inflight].filter(([, o]) => o === owner).map(([p]) => p),
    );
    await closeSessions();
    if (this.workspace && this.core) {
      await this.core.request(this.workspace.workspaceId, "resources.release", {
        owner,
      });
    }
    this.#owners.delete(owner);
    this.#releasing.delete(owner);
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled([...this.#owners].map((o) => this.release(o)));
    await this.settings.close();
    await this.workspace?.close();
    this.core?.close();
  }
}
