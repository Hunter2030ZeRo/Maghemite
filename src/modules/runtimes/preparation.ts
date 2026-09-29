import { join } from "node:path";
import { AotError, type ArtifactProducer } from "../../shared/module_aot.ts";
import { AotStore, type PreparedPackage, type ReviewedPackage } from "../host/aot.ts";
import { inspectFile, regularPath } from "../host/aot-files.ts";
import { invariant } from "../host/aot-schema.ts";
import { applicationResources, type PreparationRequest, ResourceAdmission } from "../host/resources.ts";
import { PreparationProcesses, PreparationTeardownError, drainedWithin } from "./preparation-process.ts";
import {
  beginDescriptor, nativeInfo, type PreparationAbi, type PreparationObserver, producerProtocol,
} from "./preparation-protocol.ts";
export type { PreparationEvent, PreparationObserver } from "./preparation-protocol.ts";

export interface PreparationOptions {
  readonly executable: string;
  readonly resources?: ResourceAdmission;
}
export interface PreparationRequestOptions {
  readonly operationId: string;
  readonly signal: AbortSignal;
  readonly observe?: PreparationObserver;
}

/**
 * Trusted installation/development entry point only. No registration/execution
 * path calls this class. Keep it open for the store's entire ownership lifetime.
 */
export class PreparationCoordinator {
  readonly #processes: PreparationProcesses;
  #closed = false;
  #released = false;
  #operations = new Set<Promise<unknown>>();
  private constructor(readonly store: AotStore, options: PreparationOptions, readonly ownership: Deno.FsFile) {
    this.#processes = new PreparationProcesses(options.executable, options.resources ?? applicationResources);
  }

  /** Direct embedders take equivalent exclusive store ownership, without a registry. */
  static async open(directory: string, options: PreparationOptions): Promise<PreparationCoordinator> {
    const store = await AotStore.open(directory);
    return await PreparationCoordinator.#own(store, options);
  }

  static async #own(store: AotStore, options: PreparationOptions): Promise<PreparationCoordinator> {
    const path = join(store.directory, "aot", "preparation.lock");
    const ownership = await Deno.open(path, { read: true, write: true, create: true, mode: 0o600 });
    try {
      await regularPath(store.directory, path);
      if (!await ownership.tryLock(true)) throw new AotError("in-use", "AOT store is already owned");
    } catch (error) {
      ownership.close();
      throw error;
    }
    const coordinator = new PreparationCoordinator(store, options, ownership);
    try {
      await coordinator.recover(new AbortController().signal);
      return coordinator;
    } catch (error) {
      await coordinator.close();
      throw error;
    }
  }

  /**
   * Reuses the caller's desktop profile ownership for registry operations. The
   * shared store lease also fences standalone embedders that have no profile.
   */
  static async underProfileLock(store: AotStore, options: PreparationOptions): Promise<PreparationCoordinator> {
    return await PreparationCoordinator.#own(store, options);
  }

  #track<T>(action: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new AotError("ownership", "Preparation coordinator is closed"));
    const work = action();
    this.#operations.add(work);
    void work.then(() => this.#operations.delete(work), () => this.#operations.delete(work));
    return work;
  }

  /** Reserve even orphan/unknown RSS before waiting on its old OS lease. Never adopt. */
  recover(signal: AbortSignal): Promise<void> {
    return this.#track(async () => {
      for (const id of await this.store.orphanStagingIds()) {
        const lease = await this.#processes.resources.acquirePreparation({
          moduleId: "aot.recovery", generationId: id, operationId: `recover:${id}`,
        }, signal);
        try {
          await this.store.discardOrphanStaging(id);
        } finally {
          lease.release();
        }
      }
    });
  }

  info(request: PreparationRequest, signal: AbortSignal): Promise<ReadonlyMap<PreparationAbi, ArtifactProducer>> {
    return this.#track(async () => {
      const executable = await inspectFile(this.#processes.executable, 256 * 1024 * 1024);
      let info: ReadonlyMap<PreparationAbi, ArtifactProducer> | undefined;
      await this.#processes.run({
        attribution: request, signal, args: ["--aot-info"],
        receive(value) {
          invariant(info === undefined, "Duplicate native AOT info");
          info = nativeInfo(value, executable.sha256);
          return Promise.resolve();
        },
      });
      invariant(info, "Missing native AOT info");
      return info;
    });
  }

  prepare(reviewed: ReviewedPackage, options: PreparationRequestOptions): Promise<PreparedPackage> {
    return this.#track(async () => {
      const { signal } = options;
      signal.throwIfAborted();
      const snapshot = this.store.snapshot(reviewed);
      if (!snapshot.targets.length) {
        const prepared = await this.store.lookup(reviewed, { artifactSetId: null, producers: [] });
        if (signal.aborted) await this.store.reclaim(prepared);
        signal.throwIfAborted();
        return prepared;
      }
      const attribution = {
        moduleId: snapshot.package.manifest.id,
        generationId: reviewed.slot, operationId: options.operationId,
      };
      const info = await this.info(attribution, signal);
      const producers = snapshot.targets.map((target) => {
        const producer = info.get(target.abi);
        invariant(producer, "Native ABI unavailable");
        return producer;
      });
      signal.throwIfAborted();
      const stage = await this.store.stage(reviewed, producers);
      let staged = true;
      try {
        const protocol = producerProtocol(snapshot, beginDescriptor(snapshot, producers), options.observe);
        await this.#processes.run({
          attribution: { ...attribution, generationId: stage.id }, signal,
          args: ["--aot-prepare", stage.directory], receive: protocol.receive,
        });
        protocol.complete();
        signal.throwIfAborted();
        const prepared = await this.store.publish(stage);
        staged = false;
        if (signal.aborted) {
          await this.store.reclaim(prepared);
          signal.throwIfAborted();
        }
        return prepared;
      } catch (error) {
        // Timeout is not proof of exit; keep its stage and ownership for recovery.
        if (staged && !(error instanceof PreparationTeardownError)) await this.store.discardStage(stage);
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    if (this.#released) return;
    this.#closed = true;
    await drainedWithin(Promise.allSettled([...this.#operations]));
    await this.#processes.drain();
    await this.ownership.unlock();
    this.ownership.close();
    this.#released = true;
  }

  [Symbol.asyncDispose](): Promise<void> { return this.close(); }
}
