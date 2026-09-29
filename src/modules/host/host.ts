import type { Json, Progress } from "../../../modules-sdk/js/mod.ts";
import {
  MAX_CATALOG_THEMES,
  type ThemeCatalog,
} from "../../../modules-sdk/themes/mod.ts";
import {
  type Capability,
  loadPackage,
  type ModuleManifest,
  type ModulePackage,
} from "./manifest.ts";
import { startDenoModule } from "../runtimes/deno/adapter.ts";
import { startWasmModule } from "../runtimes/wasm/adapter.ts";
import type { EventHandler, ModuleProcess } from "../runtimes/process.ts";
import { jsonCopy, receivedJson } from "../runtimes/protocol.ts";
import { delay, WorkerPool } from "./tasks.ts";
import { applicationRequest, type ApplicationServices } from "./application.ts";

import { WasmTools } from "./wasm_tools.ts";
import {
  applicationResources,
  type LoadLease,
  type ResourceAdmission,
} from "./resources.ts";
import type { ModuleState } from "../../shared/module_resources.ts";
import type { AotStore, PreparedPackage } from "./aot.ts";
import {
  pinPrepared,
  preparedToolReadiness,
  validateNativeExecutable,
} from "./prepared-readiness.ts";

export type PreparedRegistration = {
  readonly store: AotStore;
  readonly prepared: PreparedPackage;
};

/** Validated replacement owns its reference until synchronous expose or dispose. */
export interface RegistrationTransition {
  fence(): Promise<void>;
  expose(): void;
  rollback(): void;
  dispose(): void;
}

type PreparedBinding = PreparedRegistration & {
  readonly reference: { release(): void };
};

interface Entry {
  registration: string;
  owner: string;
  pkg: ModulePackage;
  prepared?: PreparedBinding;
  granted: ReadonlySet<Capability>;
  state: ModuleState;
  error: string | null;
  restarting?: boolean;
  workers: Set<Promise<Json>>;
  runtime?: ModuleProcess;
  busy: boolean;
  stop?: AbortController;
  operation?: Promise<unknown>;
  transition?: Promise<void>;
  removing?: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  suspension?: Promise<void>;
}
export interface RunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (event: Progress) => void | Promise<void>;
}
export interface HostOptions {
  /** Share this controller with other app-owned hosts and resource owners. */
  resources?: ResourceAdmission;
  application?: ApplicationServices;
  /** Global bounds across every module registered with this host. */
  workerConcurrency?: number;
  workerQueueLimit?: number;
  wasmExecutable?: string;
  denoRuntime?: import("../runtimes/deno/adapter.ts").DenoRuntimeOptions;
  /** Default 60 seconds; 0 disables unloading. Only opt-in modules are unloaded. */
  idleTimeoutMs?: number;
  onBackgroundError?: (
    moduleId: string,
    error: unknown,
  ) => void | Promise<void>;
  onLog?: (moduleId: string, message: string) => void | Promise<void>;
}

/** Application-owned registry. The manifest requests capabilities; the caller grants them. */
export class ModuleHost {
  readonly resources: ResourceAdmission;
  readonly #entries = new Map<string, Entry>();
  readonly #commands = new Map<string, string>();
  #closed = false;
  #closing?: Promise<void>;
  readonly #workers: WorkerPool;
  readonly #wasmTools: WasmTools;
  constructor(private readonly options: HostOptions = {}) {
    this.resources = options.resources ?? applicationResources;
    this.#wasmTools = new WasmTools(
      options.wasmExecutable,
      this.resources,
    );
    this.#workers = new WorkerPool(
      options.workerConcurrency,
      options.workerQueueLimit,
    );
    const idle = options.idleTimeoutMs ?? 60_000;
    if (!Number.isInteger(idle) || idle < 0 || idle > 2_147_483_647) {
      throw new Error("Invalid idle timeout");
    }
  }

  async executeFrom(
    caller: string,
    command: string,
    input: Json,
    signal: AbortSignal,
  ): Promise<Json> {
    const source = this.#entries.get(caller),
      target = this.#entries.get(this.#commands.get(command) ?? "");
    if (!source?.granted.has("commands.execute") || !target) {
      throw new Error("Command execution denied");
    }
    if (
      [...target.granted].some((capability) => !source.granted.has(capability))
    ) {
      throw new Error(
        "Target command requires permissions not granted to caller",
      );
    }
    return await this.execute(command, input, { signal });
  }

  async #release(owner: string) {
    await this.#wasmTools.release(owner);
    await this.options.application?.release?.(owner);
  }

  async register(
    directory: string,
    granted: readonly Capability[] = [],
  ): Promise<ModuleManifest> {
    if (this.#closed) throw new Error("Module host is closed");
    const pkg = await loadPackage(directory);
    if (this.#closed) throw new Error("Module host is closed");
    if (pkg.manifest.runtime === "wasm" || pkg.manifest.wasmTools?.length) {
      throw new Error(
        "Native module targets require prepared registration",
      );
    }
    return this.#registerPackage(pkg, granted);
  }

  async registerPrepared(
    value: PreparedRegistration,
    granted: readonly Capability[] = [],
  ): Promise<ModuleManifest> {
    if (this.#closed) throw new Error("Module host is closed");
    // Copy both capability identities before the first await. A caller cannot
    // substitute another store/handle while readiness validation is pending.
    const registration = Object.freeze({
      store: value.store,
      prepared: value.prepared,
    });
    const reference = registration.store.retain(registration.prepared);
    try {
      const pin = await pinPrepared(registration);
      try {
        await validateNativeExecutable(
          this.options.wasmExecutable,
          pin.descriptor,
        );
        if (this.#closed) throw new Error("Module host is closed");
        return this.#registerPackage(pin.snapshot.package, granted, {
          ...registration,
          reference,
        });
      } finally {
        pin.release();
      }
    } catch (error) {
      reference.release();
      throw error;
    }
  }

  /**
   * Installation cutover: readiness precedes fencing; expose performs no I/O.
   * The caller publishes its registry between fence() and expose(). Rollback
   * is legal only before that publication; dispose never changes live entries.
   */
  async prepareTransition(options: {
    readonly id: string;
    readonly next: PreparedRegistration | null;
    readonly grants: readonly Capability[];
    readonly enabled: boolean;
  }): Promise<RegistrationTransition> {
    if (this.#closed) throw new Error("Module host is closed");
    const previous = this.#entries.get(options.id);
    const originalState = previous?.state;
    const originalError = previous?.error ?? null;
    let binding: PreparedBinding | undefined;
    let pkg: ModulePackage | undefined;
    if (options.next) {
      const registration = { store: options.next.store, prepared: options.next.prepared };
      const reference = registration.store.retain(registration.prepared);
      try {
        const pin = await pinPrepared(registration);
        try {
          await validateNativeExecutable(this.options.wasmExecutable, pin.descriptor);
          pkg = pin.snapshot.package;
          if (pkg.manifest.id !== options.id) throw new Error("Replacement identity mismatch");
          this.#checkPackage(pkg, options.grants, options.id);
          binding = { ...registration, reference };
        } finally { pin.release(); }
      } catch (error) {
        reference.release();
        throw error;
      }
    }
    let state: "validated" | "fenced" | "exposed" | "disposed" = "validated";
    const current = () => {
      if (this.#closed || this.#entries.get(options.id) !== previous) {
        throw new Error("Module registration changed during installation");
      }
    };
    return {
      fence: async () => {
        if (state !== "validated") throw new Error("Invalid registration transition");
        current();
        state = "fenced";
        if (previous) {
          previous.removing = true;
          await this.disable(options.id);
        }
      },
      expose: () => {
        if (state !== "fenced") throw new Error("Registration is not fenced");
        current();
        if (pkg) this.#checkPackage(pkg, options.grants, options.id);
        if (previous) {
          for (const command of previous.pkg.manifest.contributions.commands) {
            this.#commands.delete(command.id);
          }
          this.#entries.delete(options.id);
          previous.prepared?.reference.release();
        }
        if (pkg) {
          this.#registerPackage(pkg, options.grants, binding);
          const entry = this.#entries.get(options.id);
          if (entry && !options.enabled) entry.state = "disabled";
        }
        state = "exposed";
      },
      rollback: () => {
        if (state === "exposed" || state === "disposed") {
          throw new Error("Registration transition is terminal");
        }
        if (state === "fenced" && previous && this.#entries.get(options.id) === previous) {
          previous.removing = false;
          previous.state = originalState === "disabled" ? "disabled"
            : originalState === "failed" ? "failed" : "registered";
          previous.error = originalError;
        }
      },
      dispose: () => {
        if (state !== "exposed" && state !== "disposed") binding?.reference.release();
        state = "disposed";
      },
    };
  }

  #checkPackage(pkg: ModulePackage, granted: readonly Capability[], replacing?: string) {
    if (this.#closed) throw new Error("Module host is closed");
    if (this.#entries.has(pkg.manifest.id) && pkg.manifest.id !== replacing) {
      throw new Error("Module is already registered");
    }
    if (
      [...this.#entries.values()].reduce(
        (count, entry) => count + (entry.pkg.manifest.id === replacing ? 0 : entry.pkg.themes.length),
        pkg.themes.length,
      ) > MAX_CATALOG_THEMES
    ) throw new Error("Theme catalog limit exceeded");
    if (granted.some((capability) => !pkg.manifest.capabilities.includes(capability))) {
      throw new Error("Cannot grant undeclared capability");
    }
  }

  #registerPackage(
    pkg: ModulePackage,
    granted: readonly Capability[],
    prepared?: PreparedBinding,
  ): ModuleManifest {
    this.#checkPackage(pkg, granted);
    this.#entries.set(pkg.manifest.id, {
      registration: crypto.randomUUID(),
      owner: crypto.randomUUID(),
      pkg,
      ...(prepared ? { prepared } : {}),
      granted: new Set(granted),
      state: "registered",
      error: null,
      workers: new Set(),
      busy: false,
    });
    for (const command of pkg.manifest.contributions.commands) {
      this.#commands.set(command.id, pkg.manifest.id);
    }
    return structuredClone(pkg.manifest);
  }

  list() {
    return [...this.#entries.values()].map((
      { pkg, state, error, busy, granted, restarting },
    ) => ({
      manifest: structuredClone(pkg.manifest),
      state: restarting ? "restarting" as const : state,
      error,
      busy,
      grants: [...granted],
    }));
  }
  languageProvider(path: string) {
    const matches = [...this.#entries.values()].filter((e) =>
      !["disabled", "failed"].includes(e.state) && !e.removing && !e.transition
    ).flatMap((e) =>
      (e.pkg.manifest.contributions.languages ?? []).filter((l) =>
        l.extensions.some((extension) => path.endsWith(extension))
      ).map((language) => ({
        moduleId: e.pkg.manifest.id,
        registration: e.registration,
        // Provider results outlive an idle guest. Package disable owns cleanup.
        owner: e.registration,
        version: e.pkg.manifest.version,
        language,
        allowed: e.granted.has("documents.read") &&
          (language.protocol !== 2 || e.granted.has("files.read")) &&
          (!e.pkg.manifest.wasmTools?.length || e.granted.has("wasm.execute")),
      }))
    );
    if (matches.length > 1) {
      throw new Error(
        "Multiple language providers match this file; disable one in Modules",
      );
    }
    return matches[0] ?? null;
  }
  /** A visible language document keeps an already-active guest warm; this never starts one. */
  keepLanguageActive(path: string, registration: string) {
    const provider = this.languageProvider(path);
    if (!provider?.allowed || provider.registration !== registration) return;
    const entry = this.#entries.get(provider.moduleId);
    if (entry?.state === "active") {
      this.#scheduleIdle(entry);
      this.#wasmTools.touch(entry.owner);
    }
  }
  async executeLanguage(
    path: string,
    registration: string,
    input: Json,
    options: RunOptions,
  ) {
    const provider = this.languageProvider(path);
    if (
      !provider || provider.registration !== registration || !provider.allowed
    ) {
      throw new Error(
        "Language provider unavailable or required permissions denied",
      );
    }
    try {
      return await this.execute(provider.language.command, input, options);
    } catch (error) {
      // Editor cancellation terminates the disposable guest, not its installed
      // provider. The next language transaction resynchronizes via begin.
      const entry = this.#entries.get(provider.moduleId);
      if (
        options.signal?.aborted && entry?.state === "failed" &&
        entry.registration === registration && !entry.transition &&
        !entry.removing
      ) {
        entry.state = "registered";
        entry.error = null;
      }
      throw error;
    }
  }
  commands() {
    return [...this.#entries.values()].filter((entry) =>
      !["disabled", "failed"].includes(entry.state) && !entry.transition && !entry.removing
    )
      .flatMap((entry) =>
        structuredClone(entry.pkg.manifest.contributions.commands)
      );
  }

  /** Static contributions survive guest failure/idle unloading, but not package disable/removal. */
  themes(): ThemeCatalog {
    return {
      schemaVersion: 1,
      themes: [...this.#entries.values()]
        .filter((entry) =>
          entry.state !== "disabled" && !entry.transition && !entry.removing
        )
        .flatMap((entry) => structuredClone(entry.pkg.themes)),
    };
  }

  #events(
    entry: Entry,
    options: RunOptions,
    worker = false,
    owner = entry.owner,
  ): EventHandler {
    return async (method, payload, signal) => {
      if (method === "app.request") {
        if (
          payload && typeof payload === "object" && "method" in payload &&
          typeof payload.method === "string" &&
          payload.method.startsWith("wasm.")
        ) {
          const binding = entry.prepared;
          const registration = entry.registration;
          return await this.#wasmTools.request(
            {
              pkg: entry.pkg,
              owner,
              granted: entry.granted,
              ...(binding
                ? {
                  prepared: preparedToolReadiness(
                    binding,
                    this.options.wasmExecutable,
                    () =>
                      this.#entries.get(entry.pkg.manifest.id) === entry &&
                      entry.registration === registration &&
                      entry.prepared?.store === binding.store &&
                      entry.prepared.prepared === binding.prepared &&
                      !entry.transition && !entry.removing &&
                      ["activating", "active"].includes(entry.state),
                  ),
                }
                : {}),
              signal,
            },
            payload,
          );
        }
        const result = await applicationRequest(
          this.options.application,
          entry.pkg.manifest.id,
          entry.granted,
          payload,
          signal,
          owner,
        );
        if (
          payload && typeof payload === "object" && "method" in payload &&
          payload.method === "app.describe" &&
          entry.granted.has("wasm.execute") && this.options.wasmExecutable
        ) {
          const description = result as { version: number; methods: string[] };
          description.methods.push(
            "wasm.start",
            "wasm.write",
            "wasm.read",
            "wasm.stop",
          );
        }
        return result;
      }
      // Timers carry no external authority; bounds and invocation ownership still apply.
      if (method === "tasks.delay") return await delay(payload, signal);
      if (!entry.granted.has(method as Capability)) {
        throw new Error(`Capability denied: ${method}`);
      }
      if (method === "tasks.run-worker") {
        if (worker) throw new Error("Workers cannot start nested workers");
        if (
          typeof payload !== "object" || payload === null ||
          Array.isArray(payload)
        ) throw new Error("Invalid worker request");
        const value = payload as { command?: unknown; input?: unknown };
        if (
          typeof value.command !== "string" ||
          !entry.pkg.manifest.workers?.includes(value.command)
        ) {
          throw new Error("Worker command is not allowlisted by this module");
        }
        const command = value.command;
        const input = jsonCopy(value.input);
        const task = this.#workers.run(
          (scope) => this.#runWorker(entry, command, input, options, scope),
          signal,
        );
        entry.workers.add(task);
        try {
          return await task;
        } finally {
          entry.workers.delete(task);
        }
      } else if (method === "log") {
        if (typeof payload !== "string" || payload.length > 4096) {
          throw new Error("Invalid log message");
        }
        await this.options.onLog?.(entry.pkg.manifest.id, payload);
      } else if (method === "tasks.progress") {
        if (typeof payload !== "object" || payload === null) {
          throw new Error("Invalid progress");
        }
        const value = payload as Progress;
        const valid = (number: unknown) =>
          typeof number === "number" && Number.isInteger(number) &&
          number >= 0 && number <= 0xFFFFFFFF;
        if (
          typeof value.message !== "string" || value.message.length > 4096 ||
          !valid(value.completed) ||
          (value.total != null &&
            (!valid(value.total) || value.total < value.completed))
        ) throw new Error("Invalid progress");
        await options.onProgress?.({
          message: value.message,
          completed: value.completed,
          ...(value.total == null ? {} : { total: value.total }),
        });
      } else throw new Error("Unknown host capability");
    };
  }

  async #start(
    entry: Entry,
    signal: AbortSignal,
    timeout: number,
    worker = false,
  ): Promise<ModuleProcess> {
    const wasm = entry.pkg.manifest.runtime === "wasm";
    const executable = this.options.wasmExecutable;
    if (wasm && !executable) {
      throw new Error("Wasm host executable is not configured");
    }
    if (!wasm) {
      const registration = entry.registration;
      const lease = await this.resources.acquire({
        moduleId: entry.pkg.manifest.id,
        kind: "deno",
        worker,
      }, signal);
      let runtime: ModuleProcess | undefined;
      try {
        signal.throwIfAborted();
        if (
          this.#entries.get(entry.pkg.manifest.id) !== entry ||
          entry.registration !== registration || entry.transition || entry.removing ||
          !["activating", "active"].includes(entry.state)
        ) throw new Error("Module registration changed before spawn");
        runtime = startDenoModule(entry.pkg, this.options.denoRuntime);
        lease.attach(runtime.pid);
        void runtime.exited.then(() => lease.release());
        return runtime;
      } catch (error) {
        await runtime?.close();
        lease.release();
        throw error;
      }
    }

    if (!executable) {
      throw new Error("Wasm host executable is not configured");
    }
    const binding = entry.prepared;
    if (!binding) {
      throw new Error("Wasm components require prepared registration");
    }
    const registration = entry.registration;
    const pin = await pinPrepared(binding);
    const descriptor = pin.descriptor;
    const generationDirectory = pin.directory;
    const generationId = binding.prepared.artifactSetId;
    const target = descriptor?.targets.find((item) =>
      item.kind === "component-entry"
    );
    if (!descriptor || !generationDirectory || !generationId || !target) {
      pin.release();
      throw new Error("Prepared component generation is unavailable");
    }
    let lease: LoadLease;
    try {
      lease = await this.resources.acquireLoad({
        moduleId: entry.pkg.manifest.id,
        generationId,
        operationId: crypto.randomUUID(),
        kind: entry.pkg.manifest.wasmResources === "compute"
          ? "wasm-compute"
          : "wasm-standard",
        artifactBytes: target.artifact.size,
        worker,
      }, signal);
    } catch (error) {
      pin.release();
      throw error;
    }
    let runtime: ModuleProcess | undefined;
    try {
      signal.throwIfAborted();
      const readiness = await pinPrepared(binding);
      try {
        await validateNativeExecutable(
          this.options.wasmExecutable,
          readiness.descriptor,
        );
      } finally {
        readiness.release();
      }
      signal.throwIfAborted();
      if (
        this.#entries.get(entry.pkg.manifest.id) !== entry ||
        entry.registration !== registration ||
        entry.prepared?.store !== binding.store ||
        entry.prepared.prepared !== binding.prepared ||
        entry.transition || entry.removing ||
        !["activating", "active"].includes(entry.state)
      ) {
        throw new Error("Module registration changed before spawn");
      }
      runtime = startWasmModule({
        generationDirectory,
        artifactSetId: generationId,
        profile: entry.pkg.manifest.wasmProfile ?? "async",
        resources: entry.pkg.manifest.wasmResources ?? "standard",
      }, executable);
      lease.attach(runtime.pid);
      void runtime.exited.then(() => {
        lease.release();
        pin.release();
      });
      await runtime.loaded.wait(signal, timeout);
      lease.loaded();
      return runtime;
    } catch (error) {
      await runtime?.close();
      lease.release();
      pin.release();
      throw error;
    }
  }

  async #runWorker(
    entry: Entry,
    command: string,
    input: Json,
    options: RunOptions,
    parent: AbortSignal,
  ): Promise<Json> {
    parent.throwIfAborted();
    const owner = crypto.randomUUID();
    const deadline = new AbortController();
    const signal = AbortSignal.any([parent, deadline.signal]);
    const timeout = options.timeoutMs ?? 30_000;
    const timer = setTimeout(
      () => deadline.abort(new Error("Worker timed out")),
      timeout,
    );
    let runtime: ModuleProcess | undefined;
    try {
      runtime = await this.#start(entry, signal, timeout, true);
      const events = this.#events(entry, options, true, owner);
      const actual = await runtime.call(
        "activate",
        {},
        events,
        signal,
        timeout,
      );
      const expected = entry.pkg.manifest.contributions.commands.map((c) =>
        c.id
      ).sort();
      if (
        !Array.isArray(actual) || actual.some((id) => typeof id !== "string") ||
        JSON.stringify([...actual].sort()) !== JSON.stringify(expected)
      ) {
        throw new Error("Worker commands do not match the manifest");
      }
      const result = jsonCopy(
        await runtime.call(
          "execute",
          { command, input },
          events,
          signal,
          timeout,
        ),
      );
      await runtime.call(
        "deactivate",
        {},
        events,
        signal,
        Math.min(2000, timeout),
      );
      return result;
    } finally {
      clearTimeout(timer);
      await runtime?.close();
      await this.#release(owner);
    }
  }

  execute(
    command: string,
    input: Json = null,
    options: RunOptions = {},
  ): Promise<Json> {
    if (this.#closed) return Promise.reject(new Error("Module host is closed"));
    const id = this.#commands.get(command);
    const entry = id && this.#entries.get(id);
    if (
      !entry || entry.transition || entry.removing ||
      ["disabled", "failed"].includes(entry.state)
    ) return Promise.reject(new Error("Command is unavailable"));
    if (entry.busy) return Promise.reject(new Error("Module is busy"));
    options.signal?.throwIfAborted();
    const timeout = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 300_000) {
      return Promise.reject(new Error("Invalid timeout"));
    }
    input = jsonCopy(input);
    this.#clearIdle(entry);
    entry.busy = true;
    entry.stop = new AbortController();
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new Error("Module call timed out")),
      timeout,
    );
    const signal = AbortSignal.any([
      entry.stop.signal,
      deadline.signal,
      ...options.signal ? [options.signal] : [],
    ]);
    const operation = this.#run(entry, command, input, options, signal, timeout)
      .finally(() => {
        clearTimeout(timer);
        entry.busy = false;
        entry.stop = undefined;
        entry.operation = undefined;
        this.#scheduleIdle(entry);
      });
    entry.operation = operation;
    return operation;
  }

  async #run(
    entry: Entry,
    command: string,
    input: Json,
    options: RunOptions,
    signal: AbortSignal,
    timeout: number,
  ): Promise<Json> {
    // Idle cleanup owns the old instance independently. Aborting a queued
    // command must not change that instance's state or wait for its deadline.
    if (entry.suspension) {
      await this.#waitForIdle(entry.suspension, signal, timeout);
    }
    signal.throwIfAborted();
    try {
      if (entry.state === "failed") {
        throw new Error("Module idle deactivation failed");
      }
      if (!entry.runtime) {
        entry.state = "activating";
        entry.owner = crypto.randomUUID();
        entry.runtime = await this.#start(entry, signal, timeout);
        const runtime = entry.runtime;
        void runtime.exited.then((error) => {
          if (entry.runtime !== runtime || entry.busy || entry.transition) {
            return;
          }
          this.#clearIdle(entry);
          entry.runtime = undefined;
          entry.state = "failed";
          entry.error = error.message;
          entry.suspension = this.#release(entry.owner).finally(() => {
            entry.suspension = undefined;
          });
          void entry.suspension.catch((cleanup) => {
            entry.error = `${error.message}; cleanup: ${String(cleanup)}`;
          });
        });
        const actual = await entry.runtime.call(
          "activate",
          {},
          this.#events(entry, {}),
          signal,
          timeout,
        );
        const expected = entry.pkg.manifest.contributions.commands.map((c) =>
          c.id
        ).sort();
        if (
          !Array.isArray(actual) || actual.some((id) =>
            typeof id !== "string"
          ) || JSON.stringify([...actual].sort()) !== JSON.stringify(expected)
        ) throw new Error("Implemented commands do not match the manifest");
        entry.state = "active";
        entry.error = null;
      }
      return receivedJson(
        await entry.runtime.call(
          "execute",
          { command, input },
          this.#events(entry, options),
          signal,
          timeout,
        ),
      );
    } catch (error) {
      entry.state = "failed";
      entry.error = String(error).slice(0, 4096);
      await entry.runtime?.close();
      entry.runtime = undefined;
      await Promise.allSettled([...entry.workers]);
      await this.#release(entry.owner);
      throw error;
    }
  }

  async #waitForIdle(
    suspension: Promise<void>,
    signal: AbortSignal,
    timeout: number,
  ) {
    signal.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () =>
        reject(
          signal.reason instanceof Error && signal.reason.name !== "AbortError"
            ? signal.reason
            : new DOMException("Module call cancelled", "AbortError"),
        );
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(
        () => reject(new Error("Module call timed out during idle cleanup")),
        timeout,
      );
    });
    try {
      await Promise.race([suspension, cancelled]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", abort!);
    }
  }

  async disable(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    if (!entry) throw new Error("Unknown module");
    if (entry.transition) {
      await entry.transition;
      if (entry.state === "disabled") return;
      return await this.disable(id);
    }
    const transition = this.#disable(entry).catch((error) => {
      entry.error = String(error).slice(0, 4096);
      throw error;
    }).finally(() => {
      entry.transition = undefined;
    });
    entry.transition = transition;
    await transition;
  }

  async #disable(entry: Entry): Promise<void> {
    const languageOwner = entry.registration;
    entry.registration = crypto.randomUUID();
    this.#clearIdle(entry);
    try {
      if (entry.busy) {
        entry.stop?.abort();
        await entry.operation?.catch(() => {});
      }
      await entry.suspension;
      await Promise.allSettled([...entry.workers]);
      if (entry.runtime && entry.state === "active") {
        try {
          await entry.runtime.call(
            "deactivate",
            {},
            this.#events(entry, {}),
            undefined,
            2000,
          );
        } finally {
          await entry.runtime.close();
          entry.runtime = undefined;
        }
      }
    } finally {
      try {
        await this.#release(entry.owner);
      } finally {
        try {
          if (entry.pkg.manifest.contributions.languages?.length) {
            await this.#release(languageOwner);
          }
        } finally {
          entry.state = "disabled";
        }
      }
    }
  }

  /** Restart only the guest owners; documents, drafts and module storage stay with the app. */
  async restart(id: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const entry = this.#entries.get(id);
    if (this.#closed || !entry || entry.transition || entry.removing) {
      throw new Error("Module cannot be restarted");
    }
    if (entry.state === "disabled") {
      throw new Error("Enable this module before restarting");
    }
    entry.restarting = true;
    const transition = (async () => {
      await this.#disable(entry);
      signal.throwIfAborted();
      if (this.#closed || entry.removing) {
        throw new Error("Module host is closing");
      }
      entry.state = "registered";
      entry.error = null;
    })().catch((error) => {
      entry.state = this.#closed ? "disabled" : "failed";
      entry.error = String(error).slice(0, 4096);
      throw error;
    }).finally(() => {
      entry.restarting = false;
      entry.transition = undefined;
    });
    entry.transition = transition;
    await transition;
  }

  #clearIdle(entry: Entry) {
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }

  #scheduleIdle(entry: Entry) {
    this.#clearIdle(entry);
    const timeout = this.options.idleTimeoutMs ?? 60_000;
    if (
      !timeout || !entry.pkg.manifest.lifecycle?.idleUnload || this.#closed ||
      entry.busy || entry.transition || entry.removing ||
      entry.state !== "active"
    ) return;
    const timer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (
        this.#closed || entry.busy || entry.transition || entry.removing ||
        entry.state !== "active"
      ) return;
      entry.state = "suspending";
      entry.suspension = this.#unloadIdle(entry).finally(() => {
        entry.suspension = undefined;
      });
    }, timeout);
    entry.idleTimer = timer;
    Deno.unrefTimer(timer);
  }

  async #unloadIdle(entry: Entry) {
    const runtime = entry.runtime!;
    entry.runtime = undefined;
    try {
      await runtime.call(
        "deactivate",
        {},
        this.#events(entry, {}),
        undefined,
        2000,
      );
      await runtime.close();
      await this.#release(entry.owner);
      entry.state = "suspended";
    } catch (error) {
      await runtime.close();
      await this.#release(entry.owner);
      entry.state = "failed";
      entry.error = String(error).slice(0, 4096);
      try {
        void Promise.resolve(
          this.options.onBackgroundError?.(entry.pkg.manifest.id, error),
        ).catch(() => {});
      } catch { /* A diagnostics consumer cannot leave cleanup unhandled. */ }
    }
  }
  enable(id: string): void {
    if (this.#closed) throw new Error("Module host is closed");
    const entry = this.#entries.get(id);
    if (
      !entry || entry.busy || entry.transition || entry.suspension ||
      entry.removing
    ) {
      throw new Error("Module cannot be enabled");
    }
    if (entry.state !== "active") {
      entry.state = "registered";
      entry.error = null;
    }
  }
  async unregister(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    if (!entry) throw new Error("Unknown module");
    entry.removing = true;
    await this.disable(id);
    for (const command of entry.pkg.manifest.contributions.commands) {
      this.#commands.delete(command.id);
    }
    this.#entries.delete(id);
    entry.prepared?.reference.release();
  }
  /** Unload folder-bound runtimes while preserving installations, grants and disabled state. */
  async resetWorkspace() {
    const enabled = [...this.#entries].filter(([, entry]) =>
      entry.state !== "disabled"
    ).map(([id]) => id);
    const results = await Promise.allSettled(
      enabled.map((id) => this.disable(id)),
    );
    for (const id of enabled) this.enable(id);
    const errors = results.filter((r) => r.status === "rejected");
    if (errors.length) {
      throw new AggregateError(
        errors.map((r) => r.reason),
        "Module cleanup failed; folder unchanged",
      );
    }
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = this.#shutdown();
    return this.#closing;
  }
  async #shutdown(): Promise<void> {
    const results = await Promise.allSettled(
      [
        this.#workers.close(),
        ...[...this.#entries.keys()].map((id) => this.disable(id)),
      ],
    );
    for (const entry of this.#entries.values()) {
      entry.prepared?.reference.release();
    }
    this.#entries.clear();
    this.#commands.clear();
    const errors = results.filter((r) => r.status === "rejected").map((r) =>
      r.reason
    );
    if (errors.length) {
      throw new AggregateError(errors, "Module shutdown failed");
    }
  }
}
