import type {
  HostResourceUsage,
  ProcessResource,
  ResourceKind,
  ResourceSnapshot,
} from "../../shared/module_resources.ts";
import {
  type OwnedProcessUsage,
  ownedProcessUsage,
  processRss,
} from "./process_usage.ts";

const MiB = 1024 * 1024;
/** Policy units derive from existing runtime limits and the recorded cold C++ peak. */
export const RESOURCE_DEFAULTS = {
  retainedEnvelopeBytes: 4 * 512 * MiB,
  compilationConcurrency: 1,
  queueLimit: 32,
  wasmStartupBytes: 1664 * MiB,
} as const;
const retainedBytes: Record<ResourceKind, number> = {
  deno: 128 * MiB,
  "wasm-standard": 128 * MiB,
  "wasm-compute": 256 * MiB,
  "wasi-tool": 512 * MiB,
};
type Request = {
  moduleId: string;
  kind: ResourceKind;
  worker?: boolean;
};
export type PreparationRequest = {
  readonly moduleId: string;
  readonly generationId: string;
  readonly operationId: string;
};
export type LoadRequest = PreparationRequest & {
  readonly kind: Exclude<ResourceKind, "deno">;
  readonly artifactBytes: number;
  readonly worker?: boolean;
};
type AdmissionRequest =
  | (Request & { readonly operation: "runtime-start" })
  | (PreparationRequest & { readonly operation: "preparation" })
  | (LoadRequest & { readonly operation: "artifact-load" })
  | {
    readonly moduleId: string;
    readonly operation: "host";
    readonly usage: HostResourceUsage;
  };
type HostResourceLease = { release(): void };
type Waiting = {
  request: AdmissionRequest;
  signal: AbortSignal;
  resolve: (lease: AdmissionLease) => void;
  reject: (error: unknown) => void;
  abort: () => void;
};
export interface ResourceLease {
  attach(pid: number): void;
  compiled(): void;
  release(): void;
}
export interface PreparationLease {
  attach(pid: number): void;
  release(): void;
}
export interface LoadLease {
  attach(pid: number): void;
  loaded(): void;
  release(): void;
}
type AdmissionLease =
  | ResourceLease
  | PreparationLease
  | LoadLease
  | HostResourceLease;
function assertNever(value: never): never {
  throw new TypeError(`Unexpected resource request: ${String(value)}`);
}
function validateAttribution(request: PreparationRequest): void {
  if (!request.moduleId || !request.generationId || !request.operationId) {
    throw new RangeError("Invalid resource operation attribution");
  }
}
export interface ResourceOptions {
  budgetBytes?: number;
  compilationConcurrency?: number;
  queueLimit?: number;
  /** Test/embedding seam. The default includes Deno and its in-process native core. */
  coreRss?: () => number;
  processRss?: (pid: number) => Promise<number | null>;
  ownedProcesses?: () => Promise<OwnedProcessUsage>;
}

/** One shared admission boundary; reservations are not OS-enforced RSS limits. */
export class ResourceAdmission extends EventTarget {
  readonly budgetBytes: number;
  readonly compilationConcurrency: number;
  readonly queueLimit: number;
  readonly #processes = new Map<string, ProcessResource>();
  readonly #queue: Waiting[] = [];
  readonly #external = new Map<string, HostResourceUsage>();
  #coreRss = 0;
  #sampledAt = 0;
  #pumping = false;
  #rendererPid: number | null = null;
  #tree: OwnedProcessUsage = {
    source: "unavailable",
    complete: false,
    processes: [],
  };
  constructor(private readonly options: ResourceOptions = {}) {
    super();
    this.#coreRss = (options.coreRss ?? (() => Deno.memoryUsage().rss))();
    this.#sampledAt = Date.now();
    this.budgetBytes = options.budgetBytes ??
      this.#coreRss + RESOURCE_DEFAULTS.retainedEnvelopeBytes +
        RESOURCE_DEFAULTS.wasmStartupBytes;
    this.compilationConcurrency = options.compilationConcurrency ??
      RESOURCE_DEFAULTS.compilationConcurrency;
    this.queueLimit = options.queueLimit ?? RESOURCE_DEFAULTS.queueLimit;
    if (
      !Number.isSafeInteger(this.budgetBytes) || this.budgetBytes < 1 ||
      !Number.isSafeInteger(this.compilationConcurrency) ||
      this.compilationConcurrency < 1 || this.compilationConcurrency > 8 ||
      !Number.isSafeInteger(this.queueLimit) || this.queueLimit < 1 ||
      this.queueLimit > 128
    ) throw new RangeError("Invalid application resource budget");
  }
  #reservation(request: AdmissionRequest): number {
    switch (request.operation) {
      case "host":
        return Math.max(
          request.usage.reservedBytes,
          request.usage.rssBytes ?? 0,
        );
      case "preparation":
        return RESOURCE_DEFAULTS.wasmStartupBytes;
      case "artifact-load":
        return retainedBytes[request.kind] + 2 * request.artifactBytes;
      case "runtime-start":
        return request.kind === "deno"
          ? retainedBytes.deno
          : RESOURCE_DEFAULTS.wasmStartupBytes;
      default:
        return assertNever(request);
    }
  }
  #usesCompiler(request: AdmissionRequest): boolean {
    switch (request.operation) {
      case "preparation":
        return true;
      case "runtime-start":
        return request.kind !== "deno";
      case "artifact-load":
      case "host":
        return false;
      default:
        return assertNever(request);
    }
  }
  #changed() {
    this.dispatchEvent(new Event("change"));
  }
  /** Parent-owned telemetry/reservations, never exposed as a module capability. */
  reportHostUsage(usage: HostResourceUsage) {
    if (
      !usage.id || !usage.label ||
      [usage.reservedBytes, usage.rssBytes, usage.diskBytes].some((value) =>
        value !== null && (!Number.isSafeInteger(value) || value < 0)
      ) ||
      (usage.pid != null && (!Number.isSafeInteger(usage.pid) || usage.pid < 1))
    ) throw new RangeError("Invalid host resource usage");
    this.#external.set(usage.id, { ...usage, reportedAt: Date.now() });
    this.#changed();
    this.#pump();
  }
  /** Renderer-owned logical Blob bytes. The renderer enforces its reported limit. */
  reportRendererAttachments(retainedBytes: number, limitBytes: number) {
    if (
      !Number.isSafeInteger(retainedBytes) ||
      !Number.isSafeInteger(limitBytes) ||
      retainedBytes < 0 || limitBytes < 1 || retainedBytes > limitBytes
    ) throw new RangeError("Invalid renderer attachment resource report");
    const id = "renderer.attachments";
    this.reportHostUsage({
      id,
      label: "Renderer attachment Blob URLs",
      pid: this.#external.get(id)?.pid ?? null,
      rssBytes: null,
      reservedBytes: limitBytes,
      diskBytes: null,
      retainedBytes,
      limitBytes,
    });
  }
  /** Reserve before creating a parent-owned process/cache; report measured usage afterward. */
  async reserveHostUsage(
    usage: HostResourceUsage,
    signal: AbortSignal,
  ): Promise<HostResourceLease> {
    if (
      !usage.id || !usage.label ||
      [usage.reservedBytes, usage.rssBytes, usage.diskBytes].some((value) =>
        value !== null && (!Number.isSafeInteger(value) || value < 0)
      ) ||
      (usage.pid != null &&
        (!Number.isSafeInteger(usage.pid) || usage.pid < 1)) ||
      this.#external.has(usage.id) ||
      this.#queue.some((q) =>
        q.request.operation === "host" && q.request.usage.id === usage.id
      )
    ) throw new Error("Invalid or duplicate host resource reservation");
    const lease = await this.#enqueue({
      moduleId: usage.id,
      operation: "host",
      usage: { ...usage },
    }, signal);
    if (signal.aborted) {
      lease.release();
      signal.throwIfAborted();
    }
    return lease;
  }
  releaseHostUsage(id: string) {
    this.#external.delete(id);
    this.#changed();
    this.#pump();
  }
  inspect(): ResourceSnapshot {
    const processes = [...this.#processes.values()];
    const rssKnown = processes.every((p) => p.rssBytes !== null);
    // One bucket per PID: guest handles and the owned tree often describe the same process.
    const byPid = new Map<number, { rss: number; reserved: number }>([
      [Deno.pid, { rss: this.#coreRss, reserved: 0 }],
    ]);
    for (const process of this.#tree.processes) {
      byPid.set(process.pid, { rss: process.rssBytes ?? 0, reserved: 0 });
    }
    let unattributed = 0;
    for (const process of [...processes, ...this.#external.values()]) {
      if (process.pid == null) {
        unattributed += Math.max(process.reservedBytes, process.rssBytes ?? 0);
        continue;
      }
      const bucket = byPid.get(process.pid) ?? { rss: 0, reserved: 0 };
      bucket.rss = Math.max(bucket.rss, process.rssBytes ?? 0);
      bucket.reserved += process.reservedBytes;
      byPid.set(process.pid, bucket);
    }
    const knownTreeRss = this.#coreRss + this.#tree.processes.reduce(
      (n, p) => n + (p.rssBytes ?? 0),
      0,
    );
    return {
      scope: "owned-process-tree-and-reported-reservations",
      sampledAt: this.#sampledAt,
      budgetBytes: this.budgetBytes,
      coreRssBytes: this.#coreRss,
      ownedTree: {
        source: this.#tree.source,
        complete: this.#tree.complete,
        processCount: 1 + this.#tree.processes.length,
        rssBytes: this.#tree.complete ? knownTreeRss : null,
        knownRssBytes: knownTreeRss,
      },
      observedModuleRssBytes: rssKnown
        ? processes.reduce((n, p) => n + (p.rssBytes ?? 0), 0)
        : null,
      reservedBytes: processes.reduce((n, p) => n + p.reservedBytes, 0) +
        [...this.#external.values()].reduce((n, p) => n + p.reservedBytes, 0),
      chargedBytes: unattributed + [...byPid.values()].reduce(
        (n, p) => n + Math.max(p.reserved, p.rss),
        0,
      ),
      compilation: {
        active: processes.filter((process) => process.compilerPermit).length,
        limit: this.compilationConcurrency,
        queued:
          this.#queue.filter((item) => this.#usesCompiler(item.request)).length,
      },
      queued: this.#queue.length,
      queueLimit: this.queueLimit,
      processes: processes.map((p) => ({ ...p })),
      external: [...this.#external.values()].map((p) => ({ ...p })),
    };
  }
  queued(moduleId: string) {
    return this.#queue.filter((q) => q.request.moduleId === moduleId).length;
  }
  async #sample() {
    this.#coreRss = (this.options.coreRss ?? (() => Deno.memoryUsage().rss))();
    this.#tree = await (this.options.ownedProcesses ?? ownedProcessUsage)();
    const attachments = this.#external.get("renderer.attachments");
    if (attachments && (attachments.pid == null || attachments.pid === this.#rendererPid)) {
      const renderers = this.#tree.processes.filter((process) => process.role === "cef-renderer");
      this.#rendererPid = renderers.length === 1 ? renderers[0].pid : null;
      attachments.pid = this.#rendererPid;
    }
    const observed = new Map(
      this.#tree.processes.map((p) => [p.pid, p.rssBytes]),
    );
    await Promise.all([...this.#processes.values()].map(async (process) => {
      if (process.pid !== null) {
        process.rssBytes = observed.has(process.pid)
          ? observed.get(process.pid) ?? null
          : await (this.options.processRss ?? processRss)(process.pid);
      }
    }));
    this.#sampledAt = Date.now();
  }
  async snapshot() {
    await this.#sample();
    this.#pump();
    return this.inspect();
  }
  async acquire(
    request: Request,
    signal: AbortSignal,
  ): Promise<ResourceLease> {
    const lease = await this.#enqueue({
      ...request,
      operation: "runtime-start",
    }, signal);
    if (signal.aborted) {
      lease.release();
      signal.throwIfAborted();
    }
    if (!("compiled" in lease)) throw new Error("Expected module resource lease");
    return lease;
  }
  async acquirePreparation(
    request: PreparationRequest,
    signal: AbortSignal,
  ): Promise<PreparationLease> {
    validateAttribution(request);
    const lease = await this.#enqueue({
      ...request,
      operation: "preparation",
    }, signal);
    if (signal.aborted) {
      lease.release();
      signal.throwIfAborted();
    }
    if (!("attach" in lease)) {
      throw new Error("Expected preparation resource lease");
    }
    return lease;
  }
  async acquireLoad(
    request: LoadRequest,
    signal: AbortSignal,
  ): Promise<LoadLease> {
    validateAttribution(request);
    const reservation = retainedBytes[request.kind] +
      2 * request.artifactBytes;
    if (
      !Number.isSafeInteger(request.artifactBytes) ||
      request.artifactBytes < 0 ||
      !Number.isSafeInteger(reservation)
    ) throw new RangeError("Invalid artifact byte length");
    const lease = await this.#enqueue({
      ...request,
      operation: "artifact-load",
    }, signal);
    if (signal.aborted) {
      lease.release();
      signal.throwIfAborted();
    }
    if (!("loaded" in lease)) throw new Error("Expected load resource lease");
    return lease;
  }
  #enqueue(
    request: AdmissionRequest,
    signal: AbortSignal,
  ): Promise<AdmissionLease> {
    signal.throwIfAborted();
    if (this.#reservation(request) > this.budgetBytes) {
      return Promise.reject(
        new Error(
          `Resource reservation for ${request.moduleId} exceeds the shared application budget`,
        ),
      );
    }
    if (this.#queue.length >= this.queueLimit) {
      return Promise.reject(
        new Error("Application resource admission queue is full"),
      );
    }
    const result = new Promise<AdmissionLease>(
      (resolve, reject) => {
        const item: Waiting = {
          request,
          signal,
          resolve,
          reject,
          abort: () => {
            const index = this.#queue.indexOf(item);
            if (index < 0) return;
            this.#queue.splice(index, 1);
            signal.removeEventListener("abort", item.abort);
            reject(signal.reason);
            this.#changed();
            this.#pump();
          },
        };
        signal.addEventListener("abort", item.abort, { once: true });
        this.#queue.push(item);
      },
    );
    this.#changed();
    this.#pump();
    return result;
  }
  #pump() {
    if (this.#pumping) return;
    this.#pumping = true;
    void (async () => {
      try {
        while (this.#queue.length) {
          await this.#sample();
          const item = this.#queue[0];
          if (!item) break;
          const snapshot = this.inspect();
          const bytes = this.#reservation(item.request);
          if (
            snapshot.chargedBytes + bytes > this.budgetBytes ||
            (this.#usesCompiler(item.request) &&
              snapshot.compilation.active >= this.compilationConcurrency)
          ) break;
          this.#queue.shift();
          item.signal.removeEventListener("abort", item.abort);
          if (item.request.operation === "host") {
            const usage = item.request.usage;
            this.reportHostUsage(usage);
            let released = false;
            item.resolve({
              release: () => {
                if (released) return;
                released = true;
                this.releaseHostUsage(usage.id);
              },
            });
            continue;
          }
          const request = item.request;
          const process: ProcessResource = (() => {
            switch (request.operation) {
              case "runtime-start":
                return {
                  id: crypto.randomUUID(),
                  moduleId: request.moduleId,
                  kind: request.kind,
                  operation: "runtime-start",
                  operationId: null,
                  generationId: null,
                  compilerPermit: request.kind !== "deno",
                  worker: request.worker ?? false,
                  phase: request.kind === "deno" ? "running" : "starting",
                  pid: null,
                  rssBytes: null,
                  reservedBytes: bytes,
                };
              case "preparation":
                return {
                  id: crypto.randomUUID(),
                  moduleId: request.moduleId,
                  kind: "aot-preparation",
                  operation: "preparation",
                  operationId: request.operationId,
                  generationId: request.generationId,
                  compilerPermit: true,
                  worker: false,
                  phase: "preparing",
                  pid: null,
                  rssBytes: null,
                  reservedBytes: bytes,
                };
              case "artifact-load":
                return {
                  id: crypto.randomUUID(),
                  moduleId: request.moduleId,
                  kind: request.kind,
                  operation: "artifact-load",
                  operationId: request.operationId,
                  generationId: request.generationId,
                  compilerPermit: false,
                  worker: request.worker ?? false,
                  phase: "loading",
                  pid: null,
                  rssBytes: null,
                  reservedBytes: bytes,
                };
              default:
                return assertNever(request);
            }
          })();
          this.#processes.set(process.id, process);
          const attach = (pid: number) => {
            if (!this.#processes.has(process.id)) return;
            process.pid = pid;
            this.#changed();
          };
          const release = () => {
            if (!this.#processes.delete(process.id)) return;
            this.#changed();
            this.#pump();
          };
          switch (request.operation) {
            case "runtime-start":
              item.resolve({
                attach,
                compiled: () => {
                  if (!this.#processes.has(process.id)) return;
                  process.phase = "running";
                  process.compilerPermit = false;
                  process.reservedBytes = retainedBytes[request.kind];
                  this.#changed();
                  this.#pump();
                },
                release,
              });
              break;
            case "preparation":
              item.resolve({ attach, release });
              break;
            case "artifact-load":
              item.resolve({
                attach,
                loaded: () => {
                  if (!this.#processes.has(process.id)) return;
                  process.phase = "running";
                  process.reservedBytes = retainedBytes[request.kind];
                  this.#changed();
                  this.#pump();
                },
                release,
              });
              break;
            default:
              assertNever(request);
          }
          this.#changed();
        }
      } catch (error) {
        for (const item of this.#queue.splice(0)) {
          item.signal.removeEventListener("abort", item.abort);
          item.reject(error);
        }
        this.#changed();
      } finally {
        this.#pumping = false;
      }
    })();
  }
}

/** Hosts in one desktop process must not silently create independent caps. */
export const applicationResources = new ResourceAdmission();
