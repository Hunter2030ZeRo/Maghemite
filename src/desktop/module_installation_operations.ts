import {
  INSTALLATION_LIMITS,
  InstallationError,
  type InstallationSnapshot,
} from "../shared/module_installations.ts";
import {
  boundedError,
  type InstallationOperation,
  type InstallationRegistry,
  RegistryFile,
  terminal,
} from "./module_installation_registry.ts";

/** Durable identity/outcomes and event subscriptions, independent of mutation admission. */
export class InstallationOperations extends EventTarget {
  readonly registry: RegistryFile;
  constructor(
    directory: string,
    readonly scheduleTimeout: (
      expire: () => void,
      milliseconds: number,
    ) => () => void = (expire, milliseconds) => {
      const timer = setTimeout(expire, milliseconds);
      return () => clearTimeout(timer);
    },
  ) {
    super();
    this.registry = new RegistryFile(directory);
  }
  find(id: string): InstallationOperation | undefined {
    const registry = this.registry.value;
    return registry.activeOperation?.snapshot.id === id
      ? registry.activeOperation
      : registry.outcomes.find((item) => item.snapshot.id === id);
  }
  snapshot(id: string): InstallationSnapshot {
    const operation = this.find(id);
    if (!operation) {
      throw new InstallationError("unknown", "Unknown installation operation");
    }
    return structuredClone(operation.snapshot);
  }
  duplicate(id: string, input: string): InstallationSnapshot | undefined {
    const found = this.find(id);
    if (!found) return;
    if (found.input !== input) {
      throw new InstallationError(
        "conflict",
        "Operation ID was already used with different inputs",
      );
    }
    return structuredClone(found.snapshot);
  }
  changed(): void {
    this.dispatchEvent(new Event("change"));
  }
  async update(
    operation: InstallationOperation,
    patch: Partial<InstallationSnapshot>,
  ): Promise<void> {
    const snapshot = {
      ...operation.snapshot,
      ...patch,
      revision: operation.snapshot.revision + 1,
    };
    const next = { ...operation, snapshot };
    await this.registry.publish(this.withOperation(next), {
      renamed: () => {
        operation.snapshot = snapshot;
        this.changed();
      },
    });
  }
  withOperation(operation: InstallationOperation): InstallationRegistry {
    const registry = this.registry.value;
    if (!terminal(operation.snapshot)) {
      return { ...registry, activeOperation: operation };
    }
    return {
      ...registry,
      activeOperation: null,
      outcomes: [
        ...registry.outcomes.filter((item) =>
          item.snapshot.id !== operation.snapshot.id
        ),
        operation,
      ].slice(-INSTALLATION_LIMITS.outcomes),
    };
  }
  async interrupt(): Promise<void> {
    const active = this.registry.value.activeOperation;
    if (active) {
      await this.update(active, {
        phase: "failed",
        error: boundedError(
          "Installation interrupted before commit; retry installation or maintenance",
        ),
      });
    }
  }
  status(
    id: string,
    afterRevision: number | undefined,
    signal: AbortSignal,
  ): Promise<InstallationSnapshot> {
    signal.throwIfAborted();
    const current = this.snapshot(id);
    if (
      afterRevision === undefined || current.revision !== afterRevision ||
      terminal(current)
    ) {
      return Promise.resolve(current);
    }
    const completion = Promise.withResolvers<InstallationSnapshot>();
    const changed = () => {
      const next = this.snapshot(id);
      if (next.revision !== afterRevision || terminal(next)) {
        completion.resolve(next);
      }
    };
    const abort = () => completion.reject(signal.reason);
    this.addEventListener("change", changed);
    signal.addEventListener("abort", abort, { once: true });
    const clear = this.scheduleTimeout(
      () => completion.resolve(this.snapshot(id)),
      INSTALLATION_LIMITS.subscriptionMs,
    );
    // Subscribe before rechecking, including a commit in the initial-read gap.
    changed();
    return completion.promise.finally(() => {
      clear();
      this.removeEventListener("change", changed);
      signal.removeEventListener("abort", abort);
    });
  }
}
