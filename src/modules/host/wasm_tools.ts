import { type ModulePackage, resolveWasmTool } from "./manifest.ts";
import { validateAppRequest } from "../../../modules-sdk/js/app.ts";
import type { Json } from "../../../modules-sdk/js/mod.ts";
import {
  applicationResources,
  type LoadLease,
  type ResourceAdmission,
} from "./resources.ts";
import type { GenerationPin } from "./aot.ts";
import type { PreparedToolReadiness } from "./prepared-readiness.ts";
import { WasiPipe } from "./wasi-pipe.ts";

export interface WasmToolRequestContext {
  readonly pkg: ModulePackage;
  readonly owner: string;
  readonly granted: ReadonlySet<string>;
  readonly prepared?: PreparedToolReadiness;
  readonly signal: AbortSignal;
}

/** Compute authority only: fixed package tools, immutable assets, no native command or workspace path. */
export class WasmTools {
  #pipes = new Map<string, { owner: string; tool: string; pipe: WasiPipe }>();
  #starting = new Map<
    string,
    Map<string, {
      stop: AbortController;
      finished: Promise<void>;
    }>
  >();
  constructor(
    private executable?: string,
    private resources: ResourceAdmission = applicationResources,
  ) {}
  async request(
    context: WasmToolRequestContext,
    payload: unknown,
  ): Promise<Json> {
    const { pkg, owner, granted, prepared, signal } = context;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Invalid WASI request");
    }
    const { method, parameters } = payload as {
      method: string;
      parameters: Record<string, string>;
    };
    validateAppRequest(method, parameters);
    if (!granted.has("wasm.execute")) {
      throw new Error("Capability denied: wasm.execute");
    }
    signal.throwIfAborted();
    if (method === "wasm.start") {
      const tool = pkg.manifest.wasmTools?.find((t) =>
        t.id === parameters.tool
      );
      if (!tool || !this.executable || !prepared) {
        throw new Error("Packaged WASI tool unavailable");
      }
      for (const [id, entry] of this.#pipes) {
        if (entry.pipe.closed) this.#pipes.delete(id);
      }
      const pending = this.#starting.get(owner) ?? new Map();
      const active = [...this.#pipes.values()];
      if (
        pending.has(tool.id) || active.some((p) =>
          p.owner === owner && p.tool === tool.id
        ) ||
        active.length +
              [...this.#starting.values()].reduce((n, s) => n + s.size, 0) >= 4
      ) {
        throw new Error("WASI tool limit exceeded or already running");
      }
      const stop = new AbortController();
      const finished = Promise.withResolvers<void>();
      const scope = AbortSignal.any([signal, stop.signal]);
      pending.set(tool.id, { stop, finished: finished.promise });
      this.#starting.set(owner, pending);
      let lease: LoadLease | undefined;
      let pin: GenerationPin | undefined;
      let pipe: WasiPipe | undefined;
      try {
        pin = await prepared.pin();
        const descriptor = pin.descriptor;
        const generationDirectory = pin.directory;
        if (!descriptor || !generationDirectory) {
          throw new Error("Prepared WASI generation is unavailable");
        }
        const generationId = prepared.generationId;
        const target = descriptor.targets.find((item) =>
          item.kind === "wasi-tool" && item.toolId === tool.id
        );
        if (!target) {
          throw new Error("Prepared WASI tool binding is unavailable");
        }
        const { assets } = await resolveWasmTool(
          pin.snapshot.package.root,
          tool,
        );
        lease = await this.resources.acquireLoad({
          moduleId: pkg.manifest.id,
          generationId,
          operationId: crypto.randomUUID(),
          kind: "wasi-tool",
          artifactBytes: target.artifact.size,
        }, scope);
        scope.throwIfAborted();
        const readiness = await prepared.pin();
        try {
          const currentTool = readiness.snapshot.package.manifest.wasmTools
            ?.find((item) => item.id === tool.id);
          if (!currentTool) {
            throw new Error("Prepared WASI tool binding is unavailable");
          }
          await resolveWasmTool(readiness.snapshot.package.root, currentTool);
          await prepared.validateNative(readiness.descriptor);
        } finally {
          readiness.release();
        }
        scope.throwIfAborted();
        if (!prepared.current()) {
          throw new Error("Module registration changed before WASI spawn");
        }
        pipe = new WasiPipe(
          new Deno.Command(this.executable, {
            args: [
              "--wasi-tool-aot",
              generationDirectory,
              generationId,
              tool.id,
              assets,
              tool.stdin ?? "blocking",
              "--",
              ...tool.args,
            ],
            clearEnv: true,
            env: { MAGHEMITE_LOAD_NOTIFY: "1" },
            stdin: "piped",
            stdout: "piped",
            stderr: "piped",
          }),
          lease,
          pin,
        );
        pin = undefined;
        await pipe.loaded.wait(scope);
        lease.loaded();
        const id = crypto.randomUUID();
        this.#pipes.set(id, { owner, tool: tool.id, pipe });
        return { id };
      } catch (error) {
        await pipe?.close();
        lease?.release();
        pin?.release();
        throw error;
      } finally {
        pending.delete(tool.id);
        if (!pending.size) this.#starting.delete(owner);
        finished.resolve();
      }
    }
    const item = this.#pipes.get(parameters.id);
    if (!item || item.owner !== owner) {
      throw new Error("WASI handle unavailable");
    }
    const { pipe } = item;
    if (method === "wasm.stop") {
      this.#pipes.delete(parameters.id);
      await pipe.close();
      return null;
    }
    if (pipe.closed) throw new Error("WASI tool has expired");
    pipe.touch();
    const abort = () => {
      void pipe.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (method === "wasm.read") return await pipe.read();
      if (method === "wasm.write") {
        if (pipe.writing) throw new Error("WASI write already pending");
        pipe.writing = true;
        try {
          await pipe.writer.write(
            Uint8Array.fromBase64(parameters.data),
          );
        } finally {
          pipe.writing = false;
        }
        return null;
      }
      throw new Error("Unsupported WASI operation");
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  touch(owner: string) {
    for (const entry of this.#pipes.values()) {
      if (entry.owner === owner && !entry.pipe.closed) entry.pipe.touch();
    }
  }
  async release(owner: string) {
    const pending = [...this.#starting.get(owner)?.values() ?? []];
    for (const item of pending) item.stop.abort();
    await Promise.all(pending.map((item) => item.finished));
    const tasks = [];
    for (const [id, entry] of this.#pipes) {
      if (entry.owner !== owner) continue;
      this.#pipes.delete(id);
      tasks.push(entry.pipe.close());
    }
    await Promise.all(tasks);
  }
}
