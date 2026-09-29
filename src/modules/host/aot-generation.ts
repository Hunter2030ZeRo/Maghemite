import { join } from "node:path";
import {
  AotError, AOT_LIMITS, type ArtifactDescriptor, type ArtifactProducer,
} from "../../shared/module_aot.ts";
import { canonicalDescriptor, invariant, parseDescriptor, sha256 } from "./aot-schema.ts";
import {
  inspectFile, integrity, readBounded, regularPath, syncDirectory,
} from "./aot-files.ts";
import { type PackageSnapshot, validateSnapshot } from "./aot-snapshot.ts";

export interface GenerationExpectation {
  readonly snapshot: PackageSnapshot;
  readonly producers: readonly ArtifactProducer[];
  readonly artifactSetId?: string;
}

async function requiredArtifactPath(
  root: string,
  path: string,
): Promise<void> {
  try {
    await regularPath(root, path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new AotError(
        "unavailable",
        "Committed AOT artifact is unavailable",
      );
    }
    throw error;
  }
}

/** Validation never starts a producer, invokes a compiler or repairs a generation. */
export async function validateGeneration(
  directory: string,
  expected: GenerationExpectation,
): Promise<ArtifactDescriptor> {
  const descriptorPath = join(directory, "descriptor.json");
  await requiredArtifactPath(directory, descriptorPath);
  const bytes = await readBounded(descriptorPath, AOT_LIMITS.descriptor);
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) {
      throw new AotError("invalid", "Malformed artifact descriptor");
    }
    throw error;
  }
  const descriptor = parseDescriptor(input);
  const canonical = canonicalDescriptor(descriptor);
  integrity(
    bytes.length === canonical.length && bytes.every((b, i) => b === canonical[i]),
    "Descriptor is not canonical",
  );
  if (expected.artifactSetId !== undefined) {
    integrity(sha256(bytes) === expected.artifactSetId, "Artifact set ID mismatch");
  }
  const snapshot = expected.snapshot;
  integrity(
    descriptor.slot === snapshot.slot &&
      descriptor.moduleId === snapshot.package.manifest.id &&
      descriptor.moduleVersion === snapshot.package.manifest.version &&
      descriptor.manifestSha256 === snapshot.manifestSha256 &&
      descriptor.targets.length === snapshot.targets.length &&
      expected.producers.length === snapshot.targets.length,
    "Descriptor does not bind the complete reviewed package",
  );
  for (const [index, target] of descriptor.targets.entries()) {
    const source = snapshot.targets[index];
    const producer = expected.producers[index];
    invariant(source && producer, "Missing expected target");
    integrity(
      target.kind === source.kind && target.toolId === source.toolId &&
        target.format === source.format && target.abi === source.abi &&
        target.sourcePath === source.sourcePath &&
        target.sourceSize === source.sourceSize &&
        target.sourceSha256 === source.sourceSha256,
      "Source target binding mismatch",
    );
    integrity(
      Object.entries(producer).every(([key, value]) =>
        Object.entries(target.producer).some(([k, v]) => k === key && v === value)
      ),
      "Incompatible native producer",
    );
    const path = join(directory, target.artifact.file);
    await requiredArtifactPath(directory, path);
    let artifact: Awaited<ReturnType<typeof inspectFile>>;
    try {
      artifact = await inspectFile(path, AOT_LIMITS.object);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new AotError(
          "unavailable",
          "Committed AOT artifact is unavailable",
        );
      }
      throw error;
    }
    integrity(
      artifact.size === target.artifact.size && artifact.sha256 === target.artifact.sha256,
      "Serialized artifact integrity mismatch",
    );
  }
  const allowed = new Set([
    "descriptor.json", "owner.lock", ...descriptor.targets.map((t) => t.artifact.file),
  ]);
  for await (const entry of Deno.readDir(directory)) {
    invariant(allowed.has(entry.name) && entry.isFile && !entry.isSymlink, "Unexpected generation file");
  }
  await validateSnapshot(snapshot);
  return descriptor;
}

/** The native child holds the same OS lease until its process exits. */
export async function withStagingLease<T>(
  directory: string,
  action: () => Promise<T>,
): Promise<T> {
  const path = join(directory, "owner.lock");
  await regularPath(directory, path);
  const file = await Deno.open(path, { read: true, write: true });
  try {
    await file.lock(true);
    try {
      return await action();
    } finally {
      await file.unlock();
    }
  } finally {
    file.close();
  }
}

export async function sealGeneration(directory: string): Promise<void> {
  for await (const entry of Deno.readDir(directory)) {
    const path = join(directory, entry.name);
    await regularPath(directory, path);
    const file = await Deno.open(path, { read: true });
    try {
      await file.sync();
    } finally {
      file.close();
    }
    if (entry.name !== "owner.lock") await Deno.chmod(path, 0o400);
  }
  await syncDirectory(directory);
}
