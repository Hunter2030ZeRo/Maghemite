import {
  defaultDataDirectory,
  developmentStorageDirectory,
} from "../../shared/application_paths.ts";
import {
  type ArtifactProducer,
  AotError,
} from "../../shared/module_aot.ts";
import type { ModuleManifest } from "./manifest.ts";
import type { PreparedRegistration } from "./host.ts";
import {
  PreparationCoordinator,
  type PreparationOptions,
} from "../runtimes/preparation.ts";
import {
  DevelopmentIndex,
  developmentPackageDigest,
} from "./development-index.ts";
import { reviewDevelopmentSource } from "./development-source.ts";

interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly operationId?: string;
}

export type PrepareRegistrationOptions =
  | (PreparationOptions & RequestOptions & {
    readonly storageRoot?: string;
    readonly coordinator?: undefined;
  })
  | (RequestOptions & {
    readonly coordinator: PreparationCoordinator;
    readonly executable?: never;
    readonly resources?: never;
    readonly storageRoot?: never;
  });

export interface PreparedRegistrationHandle extends PreparedRegistration {
  readonly root: string;
  readonly reused: boolean;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export function requiresPreparedRegistration(
  manifest: ModuleManifest,
): boolean {
  return manifest.runtime === "wasm" || !!manifest.wasmTools?.length;
}

function sameProducer(
  left: ArtifactProducer,
  right: ArtifactProducer | undefined,
): boolean {
  return right !== undefined &&
    left.identity === right.identity &&
    left.wasmtimeVersion === right.wasmtimeVersion &&
    left.recipeVersion === right.recipeVersion &&
    left.target === right.target &&
    left.cpuPolicy === right.cpuPolicy &&
    left.compilationFingerprint === right.compilationFingerprint;
}

async function compatible(
  coordinator: PreparationCoordinator,
  registration: PreparedRegistration,
  signal: AbortSignal,
  operationId: string,
): Promise<boolean> {
  const descriptor = registration.store.details(registration.prepared)
    .descriptor;
  if (!descriptor) return true;
  const producers = await coordinator.info({
    moduleId: descriptor.moduleId,
    generationId: descriptor.slot,
    operationId,
  }, signal);
  return descriptor.targets.every((target) =>
    sameProducer(target.producer, producers.get(target.abi))
  );
}

function handle(
  coordinator: PreparationCoordinator,
  prepared: PreparedRegistration["prepared"],
  owned: boolean,
  reused: boolean,
): PreparedRegistrationHandle {
  let closed = false;
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closed) return Promise.resolve();
    if (closing) return closing;
    closing = (async () => {
      try {
        if (owned) await coordinator.close();
        closed = true;
      } finally {
        if (!closed) closing = undefined;
      }
    })();
    return closing;
  };
  return Object.freeze({
    store: coordinator.store,
    prepared,
    root: coordinator.store.directory,
    reused,
    close,
    [Symbol.asyncDispose]: close,
  });
}

/**
 * Trusted developer entry point. It copies before comparing, publishes only
 * complete prepared generations, and owns no registration/execution fallback.
 */
export async function prepareRegistration(
  directory: string,
  options: PrepareRegistrationOptions,
): Promise<PreparedRegistrationHandle> {
  const owned = options.coordinator === undefined;
  const coordinator = options.coordinator ??
    await PreparationCoordinator.open(
      options.storageRoot ??
        developmentStorageDirectory(defaultDataDirectory()),
      { executable: options.executable, resources: options.resources },
    );
  const signal = options.signal ?? new AbortController().signal;
  const operationId = options.operationId ?? crypto.randomUUID();
  let reviewed: Awaited<ReturnType<typeof coordinator.store.review>> | undefined;
  let published: PreparedRegistration["prepared"] | undefined;
  try {
    signal.throwIfAborted();
    reviewed = await reviewDevelopmentSource(
      coordinator.store,
      directory,
      signal,
    );
    const snapshot = coordinator.store.snapshot(reviewed);
    const packageSha256 = await developmentPackageDigest(
      snapshot.package.root,
    );
    const index = await DevelopmentIndex.open(coordinator.store.directory);
    const reference = index.find(packageSha256);
    if (reference) {
      try {
        const prepared = await coordinator.store.restorePrepared(
          reference.slot,
          reference.artifactSetId,
        );
        const registration = { store: coordinator.store, prepared };
        if (
          await compatible(
            coordinator,
            registration,
            signal,
            `${operationId}:compatibility`,
          )
        ) {
          await coordinator.store.discardReviewed(reviewed);
          reviewed = undefined;
          return handle(coordinator, prepared, owned, true);
        }
      } catch (error) {
        if (
          !(error instanceof AotError) ||
          !["invalid", "integrity", "unavailable"].includes(error.code)
        ) throw error;
      }
    }
    if (!reviewed) {
      throw new AotError("ownership", "Reviewed package ownership lost");
    }
    published = await coordinator.prepare(reviewed, {
      operationId,
      signal,
    });
    await index.publish({
      packageSha256,
      slot: published.slot,
      artifactSetId: published.artifactSetId,
    });
    return handle(coordinator, published, owned, false);
  } catch (error) {
    if (published) await coordinator.store.reclaim(published);
    if (reviewed) await coordinator.store.discardReviewed(reviewed);
    if (owned) await coordinator.close();
    throw error;
  }
}
