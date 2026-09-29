import { isAbsolute } from "node:path";
import type { Json } from "../../modules-sdk/js/mod.ts";
import type { PreparedPackage, ReviewedPackage } from "../modules/host/aot.ts";
import {
  type Capability,
  loadPackage,
  type ModuleManifest,
} from "../modules/host/manifest.ts";
import type { ModuleHost } from "../modules/host/host.ts";
import type { PreparationCoordinator } from "../modules/runtimes/preparation.ts";
import { AotError } from "../shared/module_aot.ts";
import {
  INSTALLATION_LIMITS,
  InstallationError,
  type InstallationSnapshot,
  type InstallationState,
} from "../shared/module_installations.ts";
import { InstallationOperations } from "./module_installation_operations.ts";
import { InstallationPackages } from "./module_installation_packages.ts";
import {
  atBoundary,
  cutover,
  type InstallationTestOptions,
} from "./module_installation_transaction.ts";
import {
  boundedError,
  check,
  type InstallationOperation,
  type InstalledRecord,
  operationId,
  parseGrants,
} from "./module_installation_registry.ts";
import { installationPage, moduleSummary } from "./module_installation_view.ts";
export type { InstallationTestOptions } from "./module_installation_transaction.ts";

type Review = {
  reviewed: ReviewedPackage;
  manifest: ModuleManifest;
  expires: number;
};

/**
 * Owns accepted managed transactions, not the injected coordinator or host.
 * `change` wakes operation observers; `exposed` means catalogs actually changed.
 * allow: SIZE_OK - one mutation/acceptance/close state machine owns the commit
 * lifetime; storage, schema, subscriptions, cutover and views are separate units.
 */
export class ModuleManager extends EventTarget {
  readonly #operations: InstallationOperations;
  readonly #packages: InstallationPackages;
  readonly #reviews = new Map<string, Review>();
  readonly #errors = new Map<string, string>();
  readonly #shutdown = new AbortController();
  #busy = false;
  #closed = false;
  #restored = false;
  #work: Promise<void> = Promise.resolve();
  #mutation: Promise<unknown> = Promise.resolve();
  #accepting?: {
    id: string;
    input: string;
    promise: Promise<InstallationSnapshot>;
  };
  #cancel?: { id: string; controller: AbortController };
  #closing?: Promise<void>;
  constructor(
    readonly host: ModuleHost,
    readonly preparationCoordinator: PreparationCoordinator,
    readonly options: InstallationTestOptions = {},
  ) {
    super();
    this.#operations = new InstallationOperations(
      this.directory,
      options.scheduleStatusTimeout,
    );
    this.#packages = new InstallationPackages(preparationCoordinator.store);
    this.#operations.addEventListener(
      "change",
      () => this.dispatchEvent(new Event("change")),
    );
  }
  get directory(): string {
    return this.preparationCoordinator.store.directory;
  }
  get #records(): InstalledRecord[] {
    return this.#operations.registry.value.records;
  }
  installationState(): InstallationState {
    const registry = this.#operations.registry.value;
    return {
      activeOperation: registry.activeOperation
        ? structuredClone(registry.activeOperation.snapshot)
        : null,
      outcomes: registry.outcomes.map((item) => structuredClone(item.snapshot)),
      maintenance: [...this.#errors].map(([id, error]) => ({ id, error })),
    };
  }
  /** Called under profile/store ownership, before serving managed mutations. Never prepares. */
  async restore(): Promise<void> {
    this.#available();
    check(!this.#restored, "Module registry was already restored");
    this.#busy = true;
    const work = this.#restore();
    this.#mutation = work.then(() => undefined, () => undefined);
    try {
      await work;
    } finally {
      this.#busy = false;
    }
  }
  async #restore(): Promise<void> {
    try {
      await this.#operations.registry.read();
      await this.#operations.interrupt();
      for (const record of this.#records) {
        this.#shutdown.signal.throwIfAborted();
        check(
          !this.host.list().some((item) => item.manifest.id === record.id),
          `Installed module ${record.id} conflicts with a launch module`,
        );
        try {
          await this.#register(record);
          if (record.artifactSetId === undefined) record.artifactSetId = null;
        } catch (error) {
          this.#errors.set(record.id, boundedError(error));
        }
      }
      this.#shutdown.signal.throwIfAborted();
      await this.#operations.registry.publish(this.#operations.registry.value);
      await this.#packages.prune(this.#records);
      this.#restored = true;
    } finally {
      this.#operations.changed();
    }
  }
  async #register(record: InstalledRecord): Promise<void> {
    const prepared = await this.#packages.ready(record);
    const transition = await this.host.prepareTransition({
      id: record.id,
      next: { store: this.preparationCoordinator.store, prepared },
      grants: record.grants,
      enabled: record.enabled,
    });
    try {
      await transition.fence();
      transition.expose();
    } catch (error) {
      transition.rollback();
      throw error;
    } finally {
      transition.dispose();
    }
  }
  #available(): void {
    if (this.#closed) {
      throw new InstallationError("closed", "Module manager is closed");
    }
    if (this.#busy) {
      throw new InstallationError(
        "busy",
        "Module operation in progress; try again shortly",
      );
    }
  }
  #grants(input: unknown, manifest: ModuleManifest): Capability[] {
    const grants = parseGrants(input);
    check(
      grants.every((grant) => manifest.capabilities.includes(grant)),
      "Grant only declared module permissions",
    );
    return grants;
  }
  async #review(
    directory: Json | undefined,
    signal: AbortSignal,
  ): Promise<Json> {
    check(this.#restored, "Restore the module registry before installation");
    check(
      typeof directory === "string" && isAbsolute(directory) &&
        directory.length <= 4096,
      "Enter an absolute module package directory",
    );
    check(this.#reviews.size < 2, "Cancel the previous package review first");
    const reviewed = await this.preparationCoordinator.store.review(
      directory,
      signal,
    );
    const manifest =
      this.preparationCoordinator.store.snapshot(reviewed).package.manifest;
    try {
      const previous = this.#records.find((record) =>
        record.id === manifest.id
      );
      check(
        previous || !this.host.list().some((item) =>
          item.manifest.id === manifest.id
        ),
        "This module is managed by the launch command",
      );
      check(
        previous || this.#records.length < INSTALLATION_LIMITS.records,
        "Installed module limit reached",
      );
      const token = crypto.randomUUID();
      this.#reviews.set(token, {
        reviewed,
        manifest,
        expires: Date.now() + 600_000,
      });
      return {
        token,
        ...moduleSummary(manifest),
        update: !!previous,
        grants: previous?.grants.filter((grant) =>
          manifest.capabilities.includes(grant)
        ) ?? [],
      };
    } catch (error) {
      await this.#packages.discard(reviewed);
      throw error;
    }
  }
  async request(
    method: string,
    p: { [key: string]: Json },
    signal: AbortSignal,
  ): Promise<Json> {
    signal.throwIfAborted();
    if (method === "modules.list") {
      const offset = p.offset ?? 0;
      check(
        typeof offset === "number" && Number.isSafeInteger(offset) &&
          offset >= 0,
        "Invalid module offset",
      );
      return {
        ...await installationPage(this.host, this.#records, this.#packages, {
          offset,
          errors: this.#errors,
        }),
        ...this.installationState(),
      };
    }
    if (method === "modules.resources") {
      return await this.host.resources.snapshot();
    }
    if (method === "modules.rendererResources") {
      check(
        typeof p.attachmentBytes === "number" &&
          typeof p.attachmentLimitBytes === "number",
        "Invalid renderer resource report",
      );
      this.host.resources.reportRendererAttachments(
        p.attachmentBytes,
        p.attachmentLimitBytes,
      );
      return null;
    }
    if (method === "modules.installationStatus") {
      const id = operationId(p.operationId);
      check(
        p.afterRevision === undefined ||
          (typeof p.afterRevision === "number" &&
            Number.isSafeInteger(p.afterRevision) && p.afterRevision >= 0),
        "Invalid installation revision",
      );
      return await this.#operations.status(
        id,
        p.afterRevision,
        AbortSignal.any([signal, this.#shutdown.signal]),
      );
    }
    if (method === "modules.cancelInstallation") {
      const id = operationId(p.operationId),
        snapshot = this.#operations.snapshot(id);
      if (!snapshot.committed && this.#cancel?.id === id) {
        this.#cancel.controller.abort();
      }
      return this.#operations.snapshot(id);
    }
    if (method === "modules.install" || method === "modules.maintain") {
      const id = operationId(p.operationId);
      const kind = method === "modules.install" ? "install" : "maintenance";
      const grants = kind === "install" ? parseGrants(p.grants) : [];
      check(
        kind === "install"
          ? typeof p.token === "string"
          : typeof p.id === "string",
        "Invalid installation input",
      );
      const input = JSON.stringify(
        kind === "install"
          ? { kind, token: p.token, grants }
          : { kind, id: p.id },
      );
      const duplicate = this.#operations.duplicate(id, input);
      if (duplicate) return duplicate;
      if (this.#accepting?.id === id) {
        if (this.#accepting.input !== input) {
          throw new InstallationError(
            "conflict",
            "Operation ID was already used with different inputs",
          );
        }
        return await this.#accepting.promise;
      }
      check(this.#restored, "Restore the module registry before installation");
      this.#available();
      this.#busy = true;
      const promise = this.#accept({
        id,
        input,
        kind,
        token: String(p.token),
        moduleId: String(p.id),
        grants,
      });
      const accepting = { id, input, promise };
      this.#accepting = accepting;
      try {
        const accepted = await promise;
        await this.options.beforeResponse?.(structuredClone(accepted));
        return accepted;
      } finally {
        if (this.#accepting === accepting) this.#accepting = undefined;
      }
    }
    this.#available();
    this.#busy = true;
    const mutation = this.#mutate(
      method,
      p,
      AbortSignal.any([signal, this.#shutdown.signal]),
    );
    // The request reports its own failure. Drain owns completion, not replaying
    // an already-reported rejected configuration/review on a later close.
    this.#mutation = mutation.then(() => undefined, () => undefined);
    try {
      return await mutation;
    } catch (error) {
      if (
        error instanceof AotError && typeof p.id === "string" &&
        this.#records.some((record) => record.id === p.id)
      ) {
        this.#errors.set(p.id, boundedError(error));
      }
      throw error;
    } finally {
      this.#busy = false;
    }
  }
  async #accept(
    request: {
      id: string;
      input: string;
      kind: "install" | "maintenance";
      token: string;
      moduleId: string;
      grants: Capability[];
    },
  ): Promise<InstallationSnapshot> {
    let reviewed: ReviewedPackage | undefined;
    let scheduled = false;
    try {
      let grants: Capability[], previous: InstalledRecord | undefined;
      if (request.kind === "install") {
        const review = this.#reviews.get(request.token);
        check(
          review && review.expires >= Date.now(),
          "Package review expired; inspect it again",
        );
        reviewed = review.reviewed;
        grants = this.#grants(request.grants, review.manifest);
        previous = this.#records.find((record) =>
          record.id === review.manifest.id
        );
      } else {
        previous = this.#records.find((record) =>
          record.id === request.moduleId
        );
        check(previous, "Module is not managed by this application");
        reviewed = await this.#packages.maintenanceCopy(
          previous,
          this.#shutdown.signal,
        );
        grants = previous.grants;
      }
      const snapshot = this.preparationCoordinator.store.snapshot(reviewed);
      const operation: InstallationOperation = {
        input: request.input,
        slot: reviewed.slot,
        snapshot: {
          id: request.id,
          moduleId: snapshot.package.manifest.id,
          kind: request.kind,
          phase: "queued",
          completedTargets: 0,
          totalTargets: snapshot.targets.length,
          revision: 1,
          committed: false,
          error: null,
        },
      };
      const controller = new AbortController();
      this.#cancel = { id: request.id, controller };
      // Durable acceptance is independent of the RPC's lifetime.
      let publicationFailure: unknown;
      try {
        await this.#operations.registry.publish(
          this.#operations.withOperation(operation),
        );
      } catch (error) {
        if (
          this.#operations.registry.value.activeOperation?.snapshot.id !==
            request.id
        ) throw error;
        // Rename already accepted this identity, even if directory sync failed.
        // Keep ownership and run it; the response still surfaces the real error.
        publicationFailure = error;
      }
      this.#reviews.delete(request.token);
      this.#operations.changed();
      const accepted = structuredClone(operation.snapshot);
      this.#work = this.#run({
        operation,
        reviewed,
        previous,
        grants,
        signal: AbortSignal.any([controller.signal, this.#shutdown.signal]),
      })
        .finally(() => {
          // An unrecorded terminal result must not be overwritten by a new ID.
          this.#busy = this.#operations.registry.value.activeOperation !== null;
          this.#cancel = undefined;
          this.#operations.changed();
        });
      // Keep a rejection observed while preserving it for drain()/close().
      void this.#work.catch(() => {});
      scheduled = true;
      if (publicationFailure !== undefined) throw publicationFailure;
      return accepted;
    } catch (error) {
      if (!scheduled) {
        this.#busy = false;
        this.#cancel = undefined;
        if (request.kind === "maintenance" && reviewed) {
          await this.#packages.discard(reviewed);
        }
      }
      throw error;
    }
  }
  async #run(context: {
    operation: InstallationOperation;
    reviewed: ReviewedPackage;
    previous: InstalledRecord | undefined;
    grants: Capability[];
    signal: AbortSignal;
  }): Promise<void> {
    const { operation, reviewed, previous, grants, signal } = context;
    const transaction = { operation, signal, options: this.options };
    let prepared: PreparedPackage | undefined, committed = false;
    let failure: unknown;
    try {
      await atBoundary("queued", transaction);
      await this.#operations.update(operation, { phase: "preparing" });
      prepared = await this.preparationCoordinator.prepare(reviewed, {
        operationId: operation.snapshot.id,
        signal,
        observe: async (event) => {
          if (event.completed !== operation.snapshot.completedTargets) {
            await this.#operations.update(operation, {
              completedTargets: event.completed,
            });
          }
          await this.options.preparation?.(
            event,
            structuredClone(operation.snapshot),
          );
        },
      });
      await atBoundary("generation", transaction);
      const next: InstalledRecord = {
        id: operation.snapshot.moduleId,
        slot: reviewed.slot,
        grants,
        enabled: previous?.enabled ?? true,
        artifactSetId: prepared.artifactSetId,
      };
      const ready = prepared;
      await cutover({
        ...transaction,
        host: this.host,
        coordinator: this.preparationCoordinator,
        operations: this.#operations,
        previous,
        next,
        prepared,
        committed: () => {
          committed = true;
          this.#packages.hold(reviewed, ready);
        },
        exposed: () => {
          this.#errors.delete(next.id);
          this.dispatchEvent(new CustomEvent("exposed", { detail: next.id }));
        },
      });
      if (previous) await this.#packages.reclaim(previous);
    } catch (error) {
      failure = error;
    }
    if (!committed) {
      let cleanupFailure: unknown;
      try {
        await this.#packages.discard(reviewed, prepared);
      } catch (error) {
        cleanupFailure = error;
        failure = new AggregateError(
          [failure, error],
          "Installation cleanup failed; recovery needed",
        );
      }
      await this.#operations.update(operation, {
        phase: signal.aborted && cleanupFailure === undefined
          ? "cancelled"
          : "failed",
        error: boundedError(failure ?? "Installation did not commit"),
      });
      if (operation.snapshot.kind === "maintenance") {
        this.#errors.set(
          operation.snapshot.moduleId,
          operation.snapshot.error ?? "Maintenance failed",
        );
      }
      if (cleanupFailure !== undefined) throw failure;
    } else if (failure !== undefined) {
      const error = boundedError(
        `Installation committed; recovery needed: ${String(failure)}`,
      );
      this.#errors.set(operation.snapshot.moduleId, error);
      await this.#operations.update(operation, {
        phase: "succeeded",
        committed: true,
        error,
      });
    }
  }
  async #mutate(
    method: string,
    p: { [key: string]: Json },
    signal: AbortSignal,
  ): Promise<Json> {
    for (const [token, review] of this.#reviews) {
      if (review.expires < Date.now()) {
        await this.#packages.discard(review.reviewed);
        this.#reviews.delete(token);
      }
    }
    if (method === "modules.prepare") {
      return await this.#review(p.directory, signal);
    }
    if (method === "modules.cancel") {
      const token = String(p.token), review = this.#reviews.get(token);
      if (review) {
        await this.#packages.discard(review.reviewed);
        this.#reviews.delete(token);
      }
      return null;
    }
    check(typeof p.id === "string", "Invalid module ID");
    const previous = this.#records.find((record) => record.id === p.id);
    if (method === "modules.restart") {
      if (previous) {
        check(previous.enabled, "Enable this module before restarting");
        // Even an already active registration must pass noncompiling readiness.
        const prepared = await this.#packages.ready(previous);
        const readiness = await this.host.prepareTransition({
          id: previous.id,
          next: { store: this.preparationCoordinator.store, prepared },
          grants: previous.grants,
          enabled: previous.enabled,
        });
        readiness.dispose();
        if (
          !this.host.list().some((item) => item.manifest.id === previous.id)
        ) {
          await this.#register(previous);
          this.#errors.delete(previous.id);
          return null;
        }
      }
      await this.host.restart(p.id, signal);
      this.#errors.delete(p.id);
      return null;
    }
    check(previous, "Module is not managed by this application");
    let next: InstalledRecord | undefined,
      prepared: PreparedPackage | undefined;
    if (method === "modules.configure") {
      check(typeof p.enabled === "boolean", "Invalid module state");
      const pkg = await loadPackage(this.#packages.path(previous.slot));
      next = {
        ...previous,
        enabled: p.enabled,
        grants: this.#grants(p.grants, pkg.manifest),
      };
      prepared = await this.#packages.ready(next);
    } else check(method === "modules.remove", "Unsupported module operation");
    let committed = false;
    try {
      await cutover({
        host: this.host,
        coordinator: this.preparationCoordinator,
        operations: this.#operations,
        previous,
        next,
        prepared,
        signal,
        options: this.options,
        committed: () => {
          committed = true;
        },
        exposed: () => {
          this.#errors.delete(previous.id);
          this.dispatchEvent(
            new CustomEvent("exposed", { detail: previous.id }),
          );
        },
      });
      if (!next) await this.#packages.reclaim(previous);
    } catch (error) {
      if (committed) {
        this.#errors.set(
          previous.id,
          boundedError(`Registry committed; recovery needed: ${String(error)}`),
        );
      }
      throw error;
    }
    return null;
  }
  /** Explicit scheduler entry point; task 10 starts this only after the UI is available. */
  async maintain(
    id?: string,
    idempotencyKey = crypto.randomUUID(),
  ): Promise<InstallationSnapshot[]> {
    if (id !== undefined) {
      await this.request("modules.maintain", {
        id,
        operationId: idempotencyKey,
      }, new AbortController().signal);
      return [this.#operations.snapshot(idempotencyKey)];
    }
    const outcomes: InstallationSnapshot[] = [];
    for (const moduleId of [...this.#errors.keys()]) {
      const operationId = crypto.randomUUID();
      await this.request(
        "modules.maintain",
        { id: moduleId, operationId },
        new AbortController().signal,
      );
      await this.drain();
      outcomes.push(this.#operations.snapshot(operationId));
    }
    return outcomes;
  }
  async drain(): Promise<void> {
    // Acceptance can report a post-rename sync error while still starting work.
    // Wait for its settlement, then drain that work rather than replay the RPC.
    await Promise.allSettled([this.#accepting?.promise, this.#mutation]);
    await this.#work;
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#shutdown.abort();
    this.#closing = (async () => {
      const drained = await Promise.allSettled([this.drain()]);
      const reviews = await Promise.allSettled(
        [...this.#reviews.values()].map((review) =>
          this.#packages.discard(review.reviewed)
        ),
      );
      this.#reviews.clear();
      this.#packages.close();
      const errors = [...drained, ...reviews].flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (errors.length) {
        throw new AggregateError(errors, "Module manager shutdown failed");
      }
    })();
    return this.#closing;
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
