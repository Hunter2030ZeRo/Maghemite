import { AotError, type ArtifactDescriptor } from "../../shared/module_aot.ts";
import type { AotStore, GenerationPin, PreparedPackage } from "./aot.ts";
import { inspectFile } from "./aot-files.ts";

const MAX_NATIVE_EXECUTABLE_BYTES = 256 * 1024 * 1024;

function missingFile(error: unknown): boolean {
  return error instanceof Deno.errors.NotFound ||
    (error instanceof Error && "code" in error && error.code === "ENOENT");
}

export interface PreparedHandle {
  readonly store: AotStore;
  readonly prepared: PreparedPackage;
}

export interface PreparedToolReadiness {
  readonly generationId: string;
  readonly pin: () => Promise<GenerationPin>;
  readonly validateNative: (
    descriptor: ArtifactDescriptor | null,
  ) => Promise<void>;
  readonly current: () => boolean;
}

export async function pinPrepared(
  registration: PreparedHandle,
): Promise<GenerationPin> {
  try {
    return await registration.store.pin(registration.prepared);
  } catch (error) {
    if (missingFile(error)) {
      throw new AotError(
        "unavailable",
        "Prepared generation artifact is unavailable",
      );
    }
    throw error;
  }
}

export async function validateNativeExecutable(
  executable: string | undefined,
  descriptor: ArtifactDescriptor | null,
): Promise<void> {
  if (!descriptor?.targets.length) return;
  if (!executable) {
    throw new AotError(
      "unavailable",
      "Native host executable is not configured",
    );
  }
  let identity: string;
  try {
    identity = (await inspectFile(
      executable,
      MAX_NATIVE_EXECUTABLE_BYTES,
    )).sha256;
  } catch (error) {
    if (missingFile(error)) {
      throw new AotError(
        "unavailable",
        "Native host executable is unavailable",
      );
    }
    throw error;
  }
  if (
    descriptor.targets.some((target) => target.producer.identity !== identity)
  ) {
    throw new AotError(
      "integrity",
      "Prepared generation does not match the configured native executable",
    );
  }
}

export function preparedToolReadiness(
  registration: PreparedHandle,
  executable: string | undefined,
  current: () => boolean,
): PreparedToolReadiness | undefined {
  const generationId = registration.prepared.artifactSetId;
  if (!generationId) return undefined;
  return {
    generationId,
    pin: () => pinPrepared(registration),
    validateNative: (descriptor) =>
      validateNativeExecutable(executable, descriptor),
    current,
  };
}
