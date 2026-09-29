import type { PreparedPackage } from "../modules/host/aot.ts";
import type {
  ModuleHost,
  RegistrationTransition,
} from "../modules/host/host.ts";
import type {
  PreparationCoordinator,
  PreparationEvent,
} from "../modules/runtimes/preparation.ts";
import { interrupted } from "../modules/runtimes/preparation-process.ts";
import type { InstallationSnapshot } from "../shared/module_installations.ts";
import type { InstallationOperations } from "./module_installation_operations.ts";
import type {
  InstallationOperation,
  InstalledRecord,
} from "./module_installation_registry.ts";

export type InstallationBoundary =
  | "queued"
  | "generation"
  | "validated"
  | "fenced"
  | "before-rename";
/** Application-owned deterministic instrumentation, never an RPC or guest input. */
export interface InstallationTestOptions {
  readonly scheduleStatusTimeout?: (
    expire: () => void,
    milliseconds: number,
  ) => () => void;
  readonly boundary?: (
    boundary: InstallationBoundary,
    operation: InstallationSnapshot,
  ) => void | Promise<void>;
  readonly preparation?: (
    event: PreparationEvent,
    operation: InstallationSnapshot,
  ) => void | Promise<void>;
  readonly afterCommit?: (operation: InstallationSnapshot) => void;
  readonly afterExposure?: (operation: InstallationSnapshot) => void;
  readonly beforeResponse?: (
    operation: InstallationSnapshot,
  ) => void | Promise<void>;
}
export interface Cutover {
  readonly host: ModuleHost;
  readonly coordinator: PreparationCoordinator;
  readonly operations: InstallationOperations;
  readonly previous: InstalledRecord | undefined;
  readonly next: InstalledRecord | undefined;
  readonly prepared: PreparedPackage | undefined;
  readonly operation?: InstallationOperation;
  readonly signal: AbortSignal;
  readonly options: InstallationTestOptions;
  /** Called adjacent to rename, even if subsequent directory synchronization fails. */
  readonly committed: () => void;
  readonly exposed: () => void;
}

export async function atBoundary(
  boundary: InstallationBoundary,
  transaction: {
    readonly options: InstallationTestOptions;
    readonly operation?: InstallationOperation;
    readonly signal: AbortSignal;
  },
): Promise<void> {
  transaction.signal.throwIfAborted();
  if (transaction.operation) {
    await interrupted(
      Promise.resolve(
        transaction.options.boundary?.(
          boundary,
          structuredClone(transaction.operation.snapshot),
        ),
      ),
      transaction.signal,
    );
  }
  transaction.signal.throwIfAborted();
}

/** The registry rename decides rollback versus recovery, never a transport response. */
export async function cutover(transaction: Cutover): Promise<void> {
  const {
    previous,
    next,
    prepared,
    host,
    coordinator,
    operations,
    operation,
    signal,
  } = transaction;
  const id = next?.id ?? previous?.id;
  if (!id) throw new Error("Missing cutover identity");
  let transition: RegistrationTransition | undefined;
  let committed = false;
  try {
    transition = await host.prepareTransition({
      id,
      next: prepared ? { store: coordinator.store, prepared } : null,
      grants: next?.grants ?? [],
      enabled: next?.enabled ?? false,
    });
    await atBoundary("validated", transaction);
    if (operation) await operations.update(operation, { phase: "committing" });
    signal.throwIfAborted();
    await transition.fence();
    await atBoundary("fenced", transaction);
    const completed = operation
      ? {
        ...operation,
        snapshot: {
          ...operation.snapshot,
          phase: "succeeded" as const,
          committed: true,
          revision: operation.snapshot.revision + 1,
          error: null,
        },
      }
      : undefined;
    const registry = completed
      ? operations.withOperation(completed)
      : operations.registry.value;
    await operations.registry.publish({
      ...registry,
      records: [
        ...registry.records.filter((record) => record.id !== id),
        ...(next ? [next] : []),
      ],
    }, {
      beforeRename: () => atBoundary("before-rename", transaction),
      renamed: () => {
        committed = true;
        if (operation && completed) operation.snapshot = completed.snapshot;
        transaction.committed();
        // This callback is synchronous: no new starts can interleave commit/expose.
        if (operation) {
          transaction.options.afterCommit?.(
            structuredClone(operation.snapshot),
          );
        }
        transition?.expose();
        transaction.exposed();
        if (operation) {
          transaction.options.afterExposure?.(
            structuredClone(operation.snapshot),
          );
        }
      },
    });
  } catch (error) {
    if (!committed) transition?.rollback();
    throw error;
  } finally {
    transition?.dispose();
  }
}
