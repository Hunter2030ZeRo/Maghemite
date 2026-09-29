import { createHash } from "node:crypto";
import {
  AotError,
  AOT_LIMITS,
  type ArtifactBinding,
  type ArtifactDescriptor,
  type ArtifactProducer,
  type ArtifactSource,
  type ArtifactTarget,
} from "../../shared/module_aot.ts";

export function invariant(value: unknown, message: string): asserts value {
  if (!value) throw new AotError("invalid", message);
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  invariant(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "Expected descriptor object",
  );
  const entries = Object.entries(value);
  invariant(
    entries.length === keys.length &&
      entries.every(([key]) => keys.includes(key)),
    "Unexpected descriptor fields",
  );
  return Object.fromEntries(entries);
}

export function digest(value: unknown): string {
  invariant(typeof value === "string" && /^[0-9a-f]{64}$/.test(value), "Invalid SHA-256");
  return value;
}

export function slotId(value: unknown): string {
  invariant(
    typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value),
    "Invalid package slot",
  );
  return value;
}

export function sourcePath(value: unknown): string {
  invariant(
    typeof value === "string" && value.length <= 512 &&
      /^[A-Za-z0-9_./-]+$/.test(value) && !value.startsWith("/") &&
      value.split("/").every((p) => p && p !== "." && p !== ".."),
    "Invalid package-relative path",
  );
  return value;
}

function size(value: unknown, minimum: number, maximum: number): number {
  invariant(
    typeof value === "number" && Number.isSafeInteger(value) &&
      value >= minimum && value <= maximum,
    "Invalid or oversized artifact size",
  );
  return value;
}

function text(value: unknown): string {
  invariant(
    typeof value === "string" && value.length > 0 && value.length <= 1024 &&
      value.isWellFormed() && !value.includes("\0"),
    "Invalid producer text",
  );
  return value;
}

export function parseProducer(value: unknown): ArtifactProducer {
  const p = record(value, [
    "identity", "wasmtimeVersion", "recipeVersion", "target",
    "cpuPolicy", "compilationFingerprint",
  ]);
  invariant(
    p.wasmtimeVersion === "49.0.1" && p.recipeVersion === 1 &&
      p.cpuPolicy === "host-native",
    "Unsupported AOT producer recipe",
  );
  return Object.freeze({
    identity: digest(p.identity),
    wasmtimeVersion: p.wasmtimeVersion,
    recipeVersion: p.recipeVersion,
    target: text(p.target),
    cpuPolicy: p.cpuPolicy,
    compilationFingerprint: text(p.compilationFingerprint),
  });
}

function parseTarget(value: unknown): ArtifactTarget {
  const t = record(value, [
    "kind", "toolId", "sourcePath", "sourceSize", "sourceSha256",
    "format", "abi", "producer", "artifact",
  ]);
  let binding: ArtifactBinding;
  switch (t.kind) {
    case "component-entry":
      invariant(
        t.toolId === null && t.format === "component" &&
          (t.abi === "component-async-v1" || t.abi === "component-sync-v1"),
        "Invalid component binding",
      );
      binding = { kind: t.kind, toolId: null, format: t.format, abi: t.abi };
      break;
    case "wasi-tool":
      invariant(
        typeof t.toolId === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(t.toolId) &&
          t.format === "core-module" &&
          (t.abi === "wasi-p1-blocking-v1" || t.abi === "wasi-p1-cooperative-v1"),
        "Invalid tool binding",
      );
      binding = { kind: t.kind, toolId: t.toolId, format: t.format, abi: t.abi };
      break;
    default:
      throw new AotError("invalid", "Unknown artifact target kind");
  }
  const a = record(t.artifact, ["file", "size", "sha256"]);
  invariant(typeof a.file === "string", "Invalid generated artifact path");
  return Object.freeze({
    ...binding,
    sourcePath: sourcePath(t.sourcePath),
    sourceSize: size(t.sourceSize, 8, binding.kind === "component-entry" ? AOT_LIMITS.component : AOT_LIMITS.tool),
    sourceSha256: digest(t.sourceSha256),
    producer: parseProducer(t.producer),
    artifact: Object.freeze({
      file: a.file,
      size: size(a.size, 1, AOT_LIMITS.object),
      sha256: digest(a.sha256),
    }),
  });
}

export function compareTargets(a: ArtifactSource, b: ArtifactSource): number {
  for (const [left, right] of [[a.kind, b.kind], [a.toolId ?? "", b.toolId ?? ""], [a.sourcePath, b.sourcePath]]) {
    if (left < right) return -1;
    if (left > right) return 1;
  }
  return 0;
}

export function parseDescriptor(value: unknown): ArtifactDescriptor {
  const d = record(value, [
    "schemaVersion", "slot", "moduleId", "moduleVersion", "manifestSha256", "targets",
  ]);
  invariant(d.schemaVersion === 1, "Unsupported descriptor schema");
  invariant(typeof d.moduleId === "string" && /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(d.moduleId), "Invalid module ID");
  invariant(typeof d.moduleVersion === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(d.moduleVersion), "Invalid module version");
  invariant(Array.isArray(d.targets) && d.targets.length <= 3, "Invalid target count");
  const targets = d.targets.map(parseTarget).sort(compareTargets);
  const bindings = new Set<string>();
  let ordinal = 0;
  let total = 0;
  for (const target of targets) {
    const key = `${target.kind}:${target.toolId ?? ""}`;
    invariant(!bindings.has(key), "Duplicate target binding");
    bindings.add(key);
    const file = target.kind === "component-entry"
      ? "component.cwasm"
      : `tool-${ordinal++}.cwasm`;
    invariant(target.artifact.file === file, "Mismatched generated artifact path");
    total += target.artifact.size;
  }
  invariant(ordinal <= 2 && total <= AOT_LIMITS.generation, "Generation size or tool count exceeded");
  return Object.freeze({
    schemaVersion: 1,
    slot: slotId(d.slot),
    moduleId: d.moduleId,
    moduleVersion: d.moduleVersion,
    manifestSha256: digest(d.manifestSha256),
    targets: Object.freeze(targets),
  });
}

// Only parsed descriptor values reach this recursively ordinal-key-sorted encoder.
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, item]) => [key, ordered(item)]),
    );
  }
  return value;
}

export function canonicalDescriptor(value: ArtifactDescriptor): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(ordered(parseDescriptor(value))));
  invariant(bytes.length <= AOT_LIMITS.descriptor, "Descriptor exceeds 64 KiB");
  return bytes;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function artifactSetId(value: ArtifactDescriptor): string {
  return sha256(canonicalDescriptor(value));
}
