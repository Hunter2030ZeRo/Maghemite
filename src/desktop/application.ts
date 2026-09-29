import {
  APP_METHODS,
  type AppMethod,
  validateAppRequest,
} from "../../modules-sdk/js/app.ts";
import type { Json } from "../../modules-sdk/js/mod.ts";
import type {
  ApplicationCaller,
  ApplicationServices,
} from "../modules/host/application.ts";
import type { NativeApplicationServices } from "../core/services/application.ts";
import { decodeBase64, encodeBase64 } from "jsr:@std/encoding@1/base64";
import type { ModuleHost } from "../modules/host/host.ts";
import type { ModuleManager } from "./module_manager.ts";
import { InstallationError } from "../shared/module_installations.ts";
import { InstallationTransfers } from "./installation_transport.ts";
import { RecoveryStore } from "./recovery.ts";
import { WorkbenchPreferences } from "./preferences.ts";
import { basename, isAbsolute, join } from "node:path";
import type { FolderPicker, WorkspaceHistory } from "./workspaces.ts";
import { WorkbenchLanguages } from "./languages.ts";
import { languageProjectAccess } from "./language_project_access.ts";
import { projectPath } from "../../modules-sdk/js/project.ts";
import { WorkbenchFiles } from "./file_operations.ts";
import { FileMoveError } from "../shared/file_moves.ts";
import { jsonCopy, MAX_FRAME } from "../modules/runtimes/protocol.ts";

/** A single live workbench lease. A disconnected request is never replayed. */
export class DesktopApplication implements ApplicationServices {
  readonly preferences?: WorkbenchPreferences;
  readonly recovery?: RecoveryStore;
  readonly files?: WorkbenchFiles;
  moduleManager?: ModuleManager;
  #workspaceIdentity?: Promise<string | null>;
  #languages = new WorkbenchLanguages();
  #languageRequests = new Map<string, AbortController>();
  #documentBusy = new Set<string>();
  #switching = false;
  #closed = false;
  #observationOwner = crypto.randomUUID();
  #work = new Map<Promise<Json>, { method: string; signal: AbortSignal }>();
  #documents = new Set<Promise<Json>>();
  workspaceControls?: { history: WorkspaceHistory; pick: FolderPicker };
  async settle() {
    await Promise.allSettled([...this.#work.keys(), ...this.#documents]);
  }
  workbench(
    method: string,
    p: Record<string, Json>,
    signal: AbortSignal,
  ): Promise<Json> {
    if (this.#closed) return Promise.reject(new Error("Desktop application closed"));
    const work = this.#workbench(method, p, signal);
    this.#work.set(work, { method, signal });
    void work.finally(() => this.#work.delete(work)).catch(() => {});
    return work;
  }

  constructor(readonly native?: NativeApplicationServices) {
    if (native) {
      this.preferences = new WorkbenchPreferences(native.options.dataDirectory);
      this.recovery = new RecoveryStore(native.options.dataDirectory);
      this.files = new WorkbenchFiles({
        native,
        bindings: this.#bindings,
        documentsBusy: () => this.#documents.size > 0,
        invalidateLanguages: () => this.#languages.clear(),
        workbench: (method, parameters, caller) =>
          this.#rpc(method, parameters, caller, true),
      });
    }
  }
  workspaceIdentity(): Promise<string | null> {
    return this.#workspaceIdentity ??= (async () => {
      const root = this.native?.workspace?.root;
      if (!root) return null;
      const hash = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(root),
      );
      return [...new Uint8Array(hash)].map((b) =>
        b.toString(16).padStart(2, "0")
      ).join("");
    })();
  }
  /** Trusted workbench operations have their own allowlist; guest SDK grants are unchanged. */
  async #workbench(
    method: string,
    p: Record<string, Json>,
    signal: AbortSignal,
  ): Promise<Json> {
    signal.throwIfAborted();
    if (this.#switching && !method.startsWith("recovery.")) {
      throw new Error("Folder change in progress");
    }
    if (method === "workspace.recent") {
      return { paths: await this.workspaceControls?.history.list() ?? [] };
    }
    if (method === "workspace.browse") {
      if (!this.workspaceControls) throw new Error("Folder picker unavailable");
      return {
        path: await this.workspaceControls.pick(
          this.native?.workspace?.root ?? "",
          signal,
        ),
      };
    }
    if (method === "workspace.open") {
      if (this.files?.changing) throw new FileMoveError("File operation in progress.");
      return await this.#openWorkspace(p, signal);
    }
    const workspaceId = await this.workspaceIdentity();
    if (method === "workspace.info") {
      return {
        workspace: workspaceId
          ? {
            id: workspaceId,
            label: basename(this.native!.workspace!.root),
            path: this.native!.workspace!.root,
          }
          : null,
        preferences: this.preferences
          ? await this.preferences.get(workspaceId) as unknown as Json
          : null,
      };
    }
    if (method.startsWith("modules.")) {
      if (!this.moduleManager) throw new Error("Module manager unavailable");
      return await this.moduleManager.request(method, p, signal);
    }
    if (method === "preferences.update") {
      if (!this.preferences) throw new Error("Settings service unavailable");
      return await this.preferences.update(
        workspaceId,
        p,
        signal,
      ) as unknown as Json;
    }
    if (!workspaceId || p.workspaceId !== workspaceId) {
      throw new Error("Workspace changed; reconnect before using disk files");
    }
    if (method.startsWith("recovery.")) {
      return await this.recovery!.request(workspaceId, method, p, signal);
    }
    const { workspaceId: _, ...parameters } = p;
    const caller = {
      moduleId: "maghemite.workbench",
      owner: "workbench",
      signal,
    };
    const project = () => languageProjectAccess(
      workspaceId,
      (method, p, cleanup) => this.#rpc(method, p, {
        ...caller,
        signal: cleanup ? AbortSignal.timeout(3000) : caller.signal,
      }, method.startsWith("project.")),
      (method, p) => this.native!.request(method as AppMethod, p, caller),
      caller.signal,
    );
    if (method === "languages.cancel") {
      if (typeof p.requestId === "string") this.#languageRequests.get(p.requestId)?.abort();
      return null;
    }
    if (method === "languages.apply" || method === "languages.open") {
      if (this.files?.changing) throw new FileMoveError("File operation in progress.");
      if (!this.#modules || typeof p.proposal !== "string") {
        throw new Error("Invalid language proposal");
      }
      const location = method === "languages.open"
        ? { path: String(p.path), from: Number(p.from), to: Number(p.to) }
        : undefined;
      const work = this.#languages.projects.apply(
        this.#modules, p.proposal, project(), signal, location,
      );
      this.#documents.add(work);
      let result: Json;
      try {
        result = await work;
      } finally {
        this.#documents.delete(work);
      }
      // Project commit returns only newly materialized bindings, never source text.
      const bindings = (result as { bindings?: { path: string; version: string }[] }).bindings;
      for (const b of bindings ?? []) this.#bindings.set(b.path, { path: b.path, version: b.version });
      return result;
    }
    if (method === "languages.request") {
      if (typeof p.id !== "string" || p.id.length > 512) {
        throw new Error("Invalid language document");
      }
      const binding = this.#bindings.get(p.id);
      projectPath(p.id);
      if (!this.#modules) return null;
      if (!binding && this.#modules.languageProvider(p.id)?.language.protocol !== 2) return null;
      const controller = new AbortController();
      if (p.requestId !== undefined &&
        (typeof p.requestId !== "string" || !p.requestId || p.requestId.length > 128 ||
          this.#languageRequests.has(p.requestId))) throw new Error("Invalid language request ID");
      if (typeof p.requestId === "string") this.#languageRequests.set(p.requestId, controller);
      caller.signal = AbortSignal.any([signal, controller.signal]);
      try {
      return await this.#languages.request(
        this.#modules,
        binding?.path ?? p.id,
        parameters,
        async () => {
          const { transfer } = await this.#rpc(
            "snapshot.begin",
            { id: p.id, version: p.version },
            caller,
            true,
          ) as { transfer: string };
          try {
            let text = "", offset = 0;
            for (;;) {
              const page = await this.#rpc(
                "snapshot.read",
                { transfer, offset },
                caller,
                true,
              ) as { text: string; nextOffset: number | null };
              text += page.text;
              if (text.length > 128 * 1024) {
                throw new Error("Language source exceeds limit");
              }
              if (page.nextOffset === null) return text;
              offset = page.nextOffset;
            }
          } finally {
            await this.#rpc("transfer.abort", { transfer }, {
              ...caller,
              signal: AbortSignal.timeout(3000),
            }, true).catch(() => {});
          }
        },
        caller.signal,
        project(),
      );
      } finally {
        if (typeof p.requestId === "string") this.#languageRequests.delete(p.requestId);
      }
    }
    if (method === "documents.resume") {
      if (typeof p.path !== "string" || typeof p.diskVersion !== "string") {
        throw new Error("Invalid disk binding");
      }
      validateAppRequest("files.stat", { path: p.path });
      const stat = await this.native!.request(
        "files.stat",
        { path: p.path },
        caller,
      ) as { version: string | null };
      if (stat.version !== p.diskVersion) {
        throw new Error(
          "File changed on disk. Reload or save a separate copy before continuing.",
        );
      }
      this.#bindings.set(p.path, { path: p.path, version: p.diskVersion });
      return null;
    }
    if (method === "documents.saveNew") {
      validateAppRequest("documents.save", parameters);
      validateAppRequest("files.stat", { path: p.id });
      if (this.#bindings.has(p.id as string)) {
        throw new Error("Document already has a disk binding");
      }
      return await this.#document("documents.saveNew", parameters, caller);
    }
    if (method === "documents.reload") {
      validateAppRequest("documents.openFile", { path: p.path });
      if (typeof p.version !== "string" || p.version.length > 128) {
        throw new Error("Invalid document version");
      }
      return await this.#document("documents.openFile", {
        path: p.path,
        replaceVersion: p.version,
      }, caller);
    }
    if (method === "documents.openFile" || method === "documents.save") {
      validateAppRequest(method, parameters);
      return await this.#document(method, parameters, caller);
    }
    if (method === "files.move" || method === "files.trash" || method === "files.restoreTrash") {
      if (!this.files) throw new FileMoveError("File operations are unavailable.");
      return await this.files.request(method, parameters, caller);
    }
    if (method === "files.beginWrite" && parameters.version !== null) {
      throw new Error("Workbench uploads must create a new file.");
    }
    if (
      [
        "files.list",
        "files.stat",
        "files.read",
        "files.beginWrite",
        "files.writeChunk",
        "files.commitWrite",
        "files.abortWrite",
        "files.mkdir",
        "files.trashList",
        "events.subscribe",
        "events.next",
        "events.unsubscribe",
        "search.start",
        "search.read",
        "search.cancel",
        "search.release",
        "search.replace",
        "index.query",
        "index.status",
        "index.refresh",
      ].includes(method)
    ) {
      validateAppRequest(method as AppMethod, parameters);
      return await this.native!.request(
        method as AppMethod,
        parameters,
        method.startsWith("files.") || method.startsWith("search.") || method.startsWith("events.")
          ? {
            ...caller,
            owner: this.#observationOwner,
            grants: new Set(method.startsWith("files.") || method === "search.replace"
              ? ["files.read", "files.write"]
              : ["files.read"]),
          }
          : caller,
      );
    }
    throw new Error("Unsupported workbench operation");
  }
  async #openWorkspace(
    p: Record<string, Json>,
    signal: AbortSignal,
  ): Promise<Json> {
    if (!this.native || !this.workspaceControls || !this.#modules) {
      throw new Error("Desktop workspace service unavailable");
    }
    if (
      typeof p.path !== "string" || !p.path || p.path.length > 4096 ||
      p.path.includes("\0")
    ) throw new Error("Enter a folder path");
    const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
    const path = p.path.startsWith("~/") && home
      ? join(home, p.path.slice(2))
      : p.path;
    if (!isAbsolute(path)) throw new Error("Enter an absolute folder path");
    const staged = await this.native.prepareWorkspace(path);
    if (!staged) return { changed: false };
    this.#switching = true;
    try {
      signal.throwIfAborted();
      for (const controller of this.#commands.values()) {
        if (
          controller.signal !== signal &&
          ![...this.#work.values()].some((w) =>
            w.signal === controller.signal && w.method.startsWith("recovery.")
          )
        ) controller.abort();
      }
      await Promise.allSettled(
        [...this.#work].filter(([, work]) => work.method !== "workspace.open")
          .map(([work]) => work),
      );
      await this.#modules.resetWorkspace();
      await Promise.allSettled([...this.#documents]);
      // Snapshot AFTER stopping guest edits, before changing any folder identity.
      await this.#rpc("workspace.checkpoint", {}, {
        moduleId: "maghemite.workbench",
        owner: "workbench",
        signal,
      }, true);
      signal.throwIfAborted();
      await staged.commit();
      this.#workspaceIdentity = undefined;
      this.#bindings.clear();
      this.#languages.clear();
      this.recovery?.resetTransfers();
      let warning: string | null = null;
      try {
        await this.workspaceControls.history.remember(staged.root);
      } catch {
        warning =
          "Folder opened, but the recent folder list could not be saved.";
      }
      return { changed: true, warning };
    } finally {
      await staged.abort();
      this.#switching = false;
    }
  }
  #modules?: ModuleHost;
  #bindings = new Map<string, { path: string; version: string }>();
  readonly token = crypto.randomUUID();
  #socket?: WebSocket;
  #next = 0;
  #pending = new Map<
    number,
    { resolve(value: Json): void; reject(error: Error): void }
  >();
  #commands = new Map<number, AbortController>();
  #lastCommand = 0;
  #disconnect: () => void = () => {};
  #catalog: () => { id: string; title: string; moduleId: string }[] = () => [];
  methods(): AppMethod[] {
    const ui: AppMethod[] = this.#socket?.readyState === WebSocket.OPEN
      ? [
        "workspace.getInfo",
        "workspace.search",
        "documents.list",
        "documents.read",
        "documents.applyEdit",
        "documents.applyEdits",
        "documents.create",
        "editor.getActive",
        "editor.open",
        "editor.close",
        "editor.getSelection",
        "editor.setSelection",
        "knowledge.outline",
        "knowledge.backlinks",
        "knowledge.graph",
        "ui.notify",
        "ui.setPanel",
        "output.append",
        "commands.list",
        "commands.execute",
        "languages.register",
        "languages.remove",
        "languages.list",
        "diagnostics.publish",
        "diagnostics.clear",
        "diagnostics.list",
        "views.publish",
        "views.remove",
      ]
      : [];
    if (ui.length && this.native?.workspace) {
      ui.push("documents.openFile", "documents.save");
    }
    return [...ui, ...this.native?.methods() ?? []];
  }
  async request(
    method: AppMethod,
    parameters: Json,
    caller: ApplicationCaller,
  ): Promise<Json> {
    caller.signal.throwIfAborted();
    if (this.#switching) throw new Error("Folder change in progress");
    if (this.files?.changing && [
      "documents.applyEdit", "documents.applyEdits", "documents.create",
    ].includes(method)) throw new FileMoveError("File operation in progress.");
    if (this.native?.methods().includes(method)) {
      return await this.native.request(method, parameters, caller);
    }
    if (method === "commands.execute") {
      const p = parameters as { id: string; input: Json };
      if (!this.#modules) throw new Error("Module host disconnected");
      return await this.#modules.executeFrom(
        caller.moduleId,
        p.id,
        p.input,
        caller.signal,
      );
    }
    if (method === "documents.openFile" || method === "documents.save") {
      return await this.#document(
        method,
        parameters as Record<string, Json>,
        caller,
      );
    }
    return await this.#rpc(method, parameters, caller);
  }
  async #rpc(
    method: string,
    parameters: Json,
    caller: ApplicationCaller,
    internal = false,
  ): Promise<Json> {
    caller.signal.throwIfAborted();
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Workbench disconnected");
    }
    if (method === "commands.list") {
      const all = this.#catalog(),
        offset = (parameters as { offset?: number }).offset ?? 0;
      return {
        commands: all.slice(offset, offset + 20),
        nextOffset: offset + 20 < all.length ? offset + 20 : null,
      };
    }
    if (this.#pending.size >= 32) {
      throw new Error("Workbench request queue is full");
    }
    const id = ++this.#next, done = Promise.withResolvers<Json>();
    const timeout = ["workspace.checkpoint", "files.prepare", "files.commit"].includes(method)
      ? 25000
      : 5000;
    const abort = () => done.reject(new Error("Application request cancelled"));
    const timer = setTimeout(
      () => done.reject(new Error("Workbench request timed out")),
      timeout,
    );
    void done.promise.catch(() => {});
    this.#pending.set(id, done);
    caller.signal.addEventListener("abort", abort, { once: true });
    try {
      this.#send(socket, {
        type: "request",
        id,
        method,
        parameters,
        moduleId: caller.moduleId,
        owner: caller.owner ?? caller.moduleId,
        internal,
        expires: Date.now() + timeout,
      });
      return await done.promise;
    } finally {
      clearTimeout(timer);
      caller.signal.removeEventListener("abort", abort);
      this.#pending.delete(id);
    }
  }
  /** Authenticated UI terminal controls; modules use the capability-checked SDK route. */
  async terminal(
    action: string,
    parameters: Json,
    signal: AbortSignal,
  ): Promise<Json> {
    if (!this.native) {
      throw new Error("Desktop terminal connection unavailable");
    }
    const p = parameters as Record<string, Json>;
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      throw new Error("Invalid terminal parameters");
    }
    if (action === "list") {
      validateAppRequest("terminal.list", p);
      return {
        sessions: [...this.native.sessions.values()].filter((s) =>
          s.profile.kind === "terminal"
        ).map((s) => {
          const terminal =
            s as import("../core/services/pty.ts").TerminalSession;
          return {
            session: s.id,
            profile: s.profile.id,
            done: terminal.done,
            exitCode: terminal.exitCode,
          };
        }),
      };
    }
    if (action === "create") {
      if (Object.keys(p).some((key) => !["columns", "rows"].includes(key))) {
        throw new Error("Invalid terminal creation parameters");
      }
      validateAppRequest("terminal.create", { profile: "workbench", ...p });
      return await this.native.createWorkbenchTerminal(
        Number(p.columns ?? 80),
        Number(p.rows ?? 24),
        signal,
      );
    }
    if (!["read", "write", "resize", "close"].includes(action)) {
      throw new Error("Invalid terminal action");
    }
    const method = `terminal.${action}` as AppMethod;
    validateAppRequest(method, p);
    const session = this.native.sessions.get(String(p.session));
    if (!session || session.profile.kind !== "terminal") {
      throw new Error("Terminal session closed");
    }
    return await this.native.request(method, p, {
      moduleId: "maghemite.workbench",
      owner: session.owner,
      signal,
    });
  }
  async release(owner: string) {
    await this.native?.release(owner);
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#send(this.#socket, { type: "release", owner });
    }
  }
  #document(
    method: string,
    p: Record<string, Json>,
    caller: ApplicationCaller,
  ): Promise<Json> {
    const work = this.#runDocument(method, p, caller);
    this.#documents.add(work);
    void work.finally(() => this.#documents.delete(work)).catch(() => {});
    return work;
  }
  async #runDocument(
    method: string,
    p: Record<string, Json>,
    caller: ApplicationCaller,
  ): Promise<Json> {
    const native = this.native;
    if (!native?.workspace) throw new Error("No disk workspace selected");
    if (this.files?.changing) throw new FileMoveError("File operation in progress.");
    const documentKey = String(p.path ?? p.id);
    if (this.#documentBusy.has(documentKey)) {
      throw new Error("Document operation already in progress");
    }
    this.#documentBusy.add(documentKey);
    let transfer: string | undefined, upload: string | undefined;
    try {
      if (method === "documents.openFile") {
        const start = await this.#rpc(
          "stage.begin",
          { path: p.path },
          caller,
          true,
        ) as { transfer: string };
        transfer = start.transfer;
        let offset = 0, version: string | undefined;
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let textOffset = 0;
        for (;;) {
          const page = await native.request("files.read", {
            path: p.path,
            offset,
            ...version ? { version } : {},
          }, caller) as {
            data: string;
            version: string;
            nextOffset: number | null;
          };
          version = page.version;
          const text = decoder.decode(decodeBase64(page.data), {
            stream: page.nextOffset !== null,
          });
          if (text.includes("\0")) throw new Error("Binary document");
          for (let i = 0; i < text.length; i += 4096) {
            const chunk = text.slice(i, i + 4096);
            await this.#rpc(
              "stage.chunk",
              { transfer, offset: textOffset, text: chunk },
              caller,
              true,
            );
            textOffset += chunk.length;
          }
          if (page.nextOffset === null) break;
          offset = page.nextOffset;
        }
        const result = await this.#rpc(
          "stage.commit",
          {
            transfer,
            diskVersion: version!,
            ...(p.replaceVersion ? { replaceVersion: p.replaceVersion } : {}),
          },
          caller,
          true,
        ) as { id: string };
        transfer = undefined;
        this.#bindings.set(result.id, {
          path: p.path as string,
          version: version!,
        });
        return result;
      }
      const binding = method === "documents.saveNew"
        ? { path: p.id as string, version: null }
        : this.#bindings.get(p.id as string);
      if (!binding) {
        throw new Error(
          "Document has no disk binding; use files.beginWrite for a new file",
        );
      }
      const start = await this.#rpc(
        "snapshot.begin",
        { id: p.id, version: p.version },
        caller,
        true,
      ) as { transfer: string };
      transfer = start.transfer;
      upload = (await native.request("files.beginWrite", {
        path: binding.path,
        version: binding.version,
      }, caller) as { upload: string }).upload;
      let offset = 0, byteOffset = 0;
      for (;;) {
        const page = await this.#rpc(
          "snapshot.read",
          { transfer, offset },
          caller,
          true,
        ) as { text: string; nextOffset: number | null };
        const bytes = new TextEncoder().encode(page.text);
        await native.request("files.writeChunk", {
          upload,
          offset: byteOffset,
          data: encodeBase64(bytes),
        }, caller);
        byteOffset += bytes.length;
        if (page.nextOffset === null) break;
        offset = page.nextOffset;
      }
      const saved = await native.request(
        "files.commitWrite",
        { upload },
        caller,
      ) as { version: string };
      upload = undefined;
      binding.version = saved.version;
      this.#bindings.set(p.id as string, {
        path: binding.path,
        version: saved.version,
      });
      const result = await this.#rpc(
        "snapshot.commit",
        { transfer, diskVersion: saved.version },
        caller,
        true,
      );
      transfer = undefined;
      return result;
    } finally {
      this.#documentBusy.delete(documentKey);
      const cleanup = { ...caller, signal: AbortSignal.timeout(3000) };
      if (upload) {
        await native.request("files.abortWrite", { upload }, cleanup).catch(
          () => {},
        );
      }
      if (transfer) {
        await this.#rpc("transfer.abort", { transfer }, cleanup, true).catch(
          () => {},
        );
      }
    }
  }
  #send(socket: WebSocket, value: unknown) {
    const text = JSON.stringify(value);
    if (new TextEncoder().encode(text).length >= MAX_FRAME) {
      throw new Error("Workbench frame too large");
    }
    if (socket.bufferedAmount > MAX_FRAME * 4) {
      throw new Error("Workbench backpressure limit");
    }
    socket.send(text);
  }
  /** Only call after the desktop HTTP layer verifies origin and bearer protocol. */
  connect(request: Request, modules: ModuleHost): Response {
    if (this.#closed) return new Response("Desktop closing", { status: 503 });
    if (this.#socket || this.#switching) {
      return new Response("A workbench is already connected", { status: 409 });
    }
    const { socket, response } = Deno.upgradeWebSocket(request, {
      protocol: "maghemite-v1",
      idleTimeout: 30,
    });
    this.#socket = socket;
    this.#modules = modules;
    this.#lastCommand = 0;
    const transfers = new InstallationTransfers((message) => this.#send(socket, message));
    this.#catalog = () =>
      modules.commands().map((c) => ({
        ...c,
        moduleId: c.id.split(".").slice(0, 2).join("."),
      }));
    const disconnect = () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      this.#bindings.clear();
      this.#languages.clear();
      this.recovery?.resetTransfers();
      for (const pending of this.#pending.values()) {
        pending.reject(new Error("Workbench disconnected"));
      }
      this.#pending.clear();
      for (const abort of this.#commands.values()) abort.abort();
      this.#commands.clear();
      transfers.clear();
      this.moduleManager?.removeEventListener("change", installations);
      this.moduleManager?.removeEventListener("exposed", exposed);
      this.#releaseObservations();
    };
    this.#disconnect = disconnect;
    const catalog = () => {
      const all = this.#catalog();
      for (let offset = 0; offset < all.length || offset === 0; offset += 20) {
        this.#send(socket, {
          type: "catalog",
          offset,
          done: offset + 20 >= all.length,
          commands: all.slice(offset, offset + 20),
        });
      }
    };
    const installations = () => {
      if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      try {
        if (this.moduleManager) transfers.begin(0, {
          type: "installations",
          state: this.moduleManager.installationState(),
        });
      } catch {
        socket.close(1009);
        disconnect();
      }
    };
    const exposed = (event: Event) => {
      if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      try {
        catalog();
        if (event instanceof CustomEvent) this.#send(socket, {
          type: "modules-exposed", moduleId: event.detail,
        });
      } catch {
        socket.close(1009);
        disconnect();
      }
    };
    this.moduleManager?.addEventListener("change", installations);
    this.moduleManager?.addEventListener("exposed", exposed);
    socket.onclose = disconnect;
    socket.onerror = disconnect;
    socket.onopen = () => {
      try {
        catalog();
        installations();
      } catch {
        socket.close(1009);
        disconnect();
      }
    };
    socket.onmessage = (event) => {
      if (this.#socket !== socket) return;
      try {
        if (
          typeof event.data !== "string" ||
          new TextEncoder().encode(event.data).length >= MAX_FRAME
        ) throw new Error("Invalid workbench frame");
        const msg = JSON.parse(event.data);
        if (!msg || !Number.isSafeInteger(msg.id) || msg.id < 1) {
          throw new Error("Invalid message id");
        }
        if (
          this.#switching && msg.type !== "result" && msg.type !== "cancelRequest" &&
          msg.type !== "nextInstallationChunk" &&
          !(msg.type === "workbench" && typeof msg.action === "string" &&
            msg.action.startsWith("recovery."))
        ) {
          if (msg.type !== "event") {
            this.#send(socket, {
              type: "executed",
              id: msg.id,
              ok: false,
              error: "Folder change in progress",
            });
          }
          return;
        }
        if (msg.type === "nextInstallationChunk") {
          if (
            msg.id <= this.#lastCommand ||
            !Number.isSafeInteger(msg.requestId) || msg.requestId < 0 ||
            msg.requestId >= msg.id ||
            !Number.isSafeInteger(msg.transfer) || msg.transfer < 1 ||
            !Number.isSafeInteger(msg.offset) || msg.offset < 0
          ) throw new Error("Invalid installation transfer acknowledgement");
          this.#lastCommand = msg.id;
          transfers.next(msg.requestId, msg.transfer, msg.offset);
        } else if (msg.type === "cancelRequest") {
          if (
            msg.id <= this.#lastCommand ||
            !Number.isSafeInteger(msg.requestId) || msg.requestId < 1 ||
            msg.requestId >= msg.id
          ) throw new Error("Invalid request cancellation");
          this.#lastCommand = msg.id;
          this.#commands.get(msg.requestId)?.abort();
          transfers.cancel(msg.requestId);
        } else if (msg.type === "result") {
          const pending = this.#pending.get(msg.id);
          if (!pending) return; // Late reply after cancellation; never reuse IDs.
          this.#pending.delete(msg.id);
          if (msg.ok === true) pending.resolve(jsonCopy(msg.value));
          else if (msg.ok === false && typeof msg.error === "string") {
            pending.reject(new Error(msg.error.slice(0, 2048)));
          } else throw new Error("Invalid result");
        } else if (msg.type === "workbench") {
          if (
            msg.id <= this.#lastCommand ||
            typeof msg.action !== "string" ||
            !msg.parameters || typeof msg.parameters !== "object" ||
            Array.isArray(msg.parameters)
          ) {
            throw new Error("Invalid workbench request");
          }
          this.#lastCommand = msg.id;
          const cancellation = msg.action === "languages.cancel" ||
            msg.action === "modules.cancelInstallation";
          if (this.#commands.size >= (cancellation ? 16 : 8)) {
            this.#send(socket, {
              type: "executed",
              id: msg.id,
              ok: false,
              error: "Workbench request queue is full; retry shortly",
            });
            return;
          }
          const abort = new AbortController();
          this.#commands.set(msg.id, abort);
          const reply = (value: unknown) => {
            if (
              this.#socket === socket && socket.readyState === WebSocket.OPEN
            ) {
              if (msg.action === "modules.list") transfers.begin(msg.id, value);
              else this.#send(socket, value);
            }
          };
          void this.workbench(
            msg.action,
            jsonCopy(msg.parameters) as Record<string, Json>,
            abort.signal,
          ).then(
            (value) => {
              reply({ type: "executed", id: msg.id, ok: true, value });
              if (
                msg.action === "workspace.open" &&
                (value as { changed: boolean }).changed
              ) {
                // Reply first; reconnect then loads the new folder's preferences and drafts.
                socket.close(1001, "Workspace changed");
                disconnect();
              }
            },
            (error) => {
              const state = this.moduleManager?.installationState();
              const known = state?.activeOperation?.id === msg.parameters.operationId ||
                state?.outcomes.some((item) => item.id === msg.parameters.operationId);
              const notAccepted = error instanceof InstallationError && !known &&
                (msg.action === "modules.install" || msg.action === "modules.maintain");
              reply({
                type: "executed",
                id: msg.id,
                ok: false,
                error: String(error).slice(0, 2048),
                ...(notAccepted ? { installationAccepted: false } : {}),
              });
            },
          ).catch(() => socket.close(1011)).finally(() => {
            if (this.#socket === socket) this.#commands.delete(msg.id);
          });
        } else if (msg.type === "saveDocument") {
          if (msg.id <= this.#lastCommand || this.#commands.size >= 8) {
            throw new Error("Invalid save request");
          }
          this.#lastCommand = msg.id;
          validateAppRequest("documents.save", msg.parameters);
          const abort = new AbortController();
          this.#commands.set(msg.id, abort);
          void this.#document("documents.save", msg.parameters, {
            moduleId: "maghemite.workbench",
            owner: "workbench",
            signal: abort.signal,
          }).then(
            (value) =>
              this.#send(socket, {
                type: "executed",
                id: msg.id,
                ok: true,
                value,
              }),
            (error) =>
              this.#send(socket, {
                type: "executed",
                id: msg.id,
                ok: false,
                error: String(error),
              }),
          ).catch(() => socket.close(1011)).finally(() =>
            this.#commands.delete(msg.id)
          );
        } else if (msg.type === "terminal") {
          if (msg.id <= this.#lastCommand || this.#commands.size >= 16) {
            throw new Error("Invalid terminal request");
          }
          this.#lastCommand = msg.id;
          const abort = new AbortController();
          this.#commands.set(msg.id, abort);
          void this.terminal(
            msg.action,
            jsonCopy(msg.parameters),
            AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]),
          ).then(
            (value) =>
              this.#send(socket, {
                type: "executed",
                id: msg.id,
                ok: true,
                value,
              }),
            (error) =>
              this.#send(socket, {
                type: "executed",
                id: msg.id,
                ok: false,
                error: String(error).slice(0, 2048),
              }),
          ).catch(() => socket.close(1011)).finally(() => {
            if (this.#socket === socket) this.#commands.delete(msg.id);
          });
        } else if (msg.type === "event") {
          if (
            msg.id <= this.#lastCommand ||
            ![
              "documents.changed",
              "editor.selection",
              "workspace.changed",
              "diagnostics.changed",
              "views.action",
            ].includes(msg.topic)
          ) throw new Error("Invalid workbench event");
          this.#lastCommand = msg.id;
          this.native?.events.emit(
            msg.topic,
            jsonCopy(msg.data),
            typeof msg.owner === "string" ? msg.owner : undefined,
          );
        } else if (msg.type === "execute") {
          if (
            msg.id <= this.#lastCommand || this.#commands.size >= 8 ||
            typeof msg.command !== "string"
          ) throw new Error("Invalid command request");
          this.#lastCommand = msg.id;
          const abort = new AbortController();
          this.#commands.set(msg.id, abort);
          const reply = (data: unknown) => {
            if (
              this.#socket === socket && socket.readyState === WebSocket.OPEN
            ) this.#send(socket, data);
          };
          void modules.execute(msg.command, jsonCopy(msg.input), {
            signal: abort.signal,
          }).then(
            (value) => reply({ type: "executed", id: msg.id, ok: true, value }),
            (error) =>
              reply({
                type: "executed",
                id: msg.id,
                ok: false,
                error: String(error).slice(0, 2048),
              }),
          ).catch(() => socket.close(1011)).finally(() => {
            if (this.#socket === socket) {
              this.#commands.delete(msg.id);
              if (socket.readyState === WebSocket.OPEN) {
                try {
                  catalog();
                } catch {
                  socket.close(1011);
                }
              }
            }
          });
        } else throw new Error("Unknown workbench message");
      } catch {
        socket.close(1008, "Invalid workbench protocol");
        disconnect();
      }
    };
    return response;
  }
  #releaseObservations() {
    this.moduleManager?.host.resources.releaseHostUsage("renderer.attachments");
    const owner = this.#observationOwner;
    this.#observationOwner = crypto.randomUUID();
    if (!this.native) return;
    const cleanup = this.native.release(owner).then(() => null);
    this.#work.set(cleanup, {
      method: "workbench.cleanup",
      signal: new AbortController().signal,
    });
    void cleanup.catch((error) => {
      console.warn("Workbench resource cleanup failed", error);
    }).finally(() => this.#work.delete(cleanup));
  }
  /** Release the UI lease, not accepted application-owned installations. */
  disconnectWorkbench() {
    this.#socket?.close(1001, "Workbench disconnected");
    this.#disconnect();
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    const connected = !!this.#socket;
    this.#socket?.close(1001, "Desktop closing");
    this.#disconnect();
    if (!connected) this.#releaseObservations();
  }
}
