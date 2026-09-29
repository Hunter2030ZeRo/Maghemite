import {
  AotError, type ArtifactBinding, type ArtifactDescriptor, type ArtifactProducer,
} from "../../shared/module_aot.ts";
import { invariant, parseDescriptor, parseProducer } from "../host/aot-schema.ts";
import type { PackageSnapshot } from "../host/aot-snapshot.ts";

export type PreparationAbi = ArtifactBinding["abi"];
const abis: readonly PreparationAbi[] = [
  "component-async-v1", "component-sync-v1", "wasi-p1-blocking-v1", "wasi-p1-cooperative-v1",
];

export function nativeInfo(value: Record<string, unknown>, identity: string): ReadonlyMap<PreparationAbi, ArtifactProducer> {
  invariant(value.type === "info" && value.schemaVersion === 1 && Array.isArray(value.producers), "Invalid native AOT info");
  const result = new Map<PreparationAbi, ArtifactProducer>();
  for (const item of value.producers) {
    invariant(typeof item === "object" && item !== null && "abi" in item && "producer" in item, "Invalid native producer");
    const abi = abis.find((abi) => abi === item.abi);
    invariant(abi && !result.has(abi), "Unknown or duplicate native ABI");
    const producer = parseProducer(item.producer);
    invariant(producer.identity === identity, "Native executable identity mismatch");
    result.set(abi, producer);
  }
  invariant(result.size === abis.length, "Incomplete native ABI information");
  return result;
}

/** Draft artifact fields are not authority. The child replaces them from its bytes. */
export function beginDescriptor(
  snapshot: PackageSnapshot,
  producers: readonly ArtifactProducer[],
): ArtifactDescriptor {
  let ordinal = 0;
  return parseDescriptor({
    schemaVersion: 1, slot: snapshot.slot,
    moduleId: snapshot.package.manifest.id,
    moduleVersion: snapshot.package.manifest.version,
    manifestSha256: snapshot.manifestSha256,
    targets: snapshot.targets.map((target, index) => ({
      ...target, producer: producers[index],
      artifact: {
        file: target.kind === "component-entry" ? "component.cwasm" : `tool-${ordinal++}.cwasm`,
        size: 1, sha256: "0".repeat(64),
      },
    })),
  });
}

export interface PreparationEvent {
  readonly phase: "waiting" | "locked" | "compiling" | "target" | "ready";
  readonly pid: number;
  readonly completed: number;
  readonly total: number;
}

/** Trusted host callbacks can hold protocol barriers; never expose them to guests. */
export type PreparationObserver = (event: PreparationEvent) => void | Promise<void>;

export function producerProtocol(
  snapshot: PackageSnapshot,
  descriptor: ArtifactDescriptor,
  observe?: PreparationObserver,
) {
  let phase: "spawned" | "waiting" | "locked" | "compiling" | "target" | "ready" = "spawned";
  let completed = 0;
  return {
    async receive(value: Record<string, unknown>, send: (value: unknown) => Promise<void>, pid: number) {
      switch (value.type) {
        case "waiting":
          invariant(phase === "spawned", "Unexpected lease wait");
          phase = "waiting";
          break;
        case "locked":
          invariant(phase === "waiting", "Unexpected lease acknowledgement");
          phase = "locked";
          await observe?.({ phase, pid, completed, total: snapshot.targets.length });
          await send({ type: "begin", packageRoot: snapshot.package.root, descriptor });
          return;
        case "compiling":
          invariant((phase === "locked" || phase === "target") && value.index === completed, "Unexpected compilation progress");
          phase = "compiling";
          break;
        case "target":
          invariant(phase === "compiling" && value.completed === completed + 1 && completed < snapshot.targets.length, "Unexpected target completion");
          completed++;
          phase = "target";
          break;
        case "ready":
          invariant(phase === "target" && completed === snapshot.targets.length && value.total === completed, "Incomplete preparation");
          phase = "ready";
          await observe?.({ phase, pid, completed, total: snapshot.targets.length });
          await send({ type: "finish" });
          return;
        default:
          throw new AotError("invalid", "Unknown native preparation event");
      }
      await observe?.({ phase, pid, completed, total: snapshot.targets.length });
    },
    complete() { invariant(phase === "ready", "Native producer exited before readiness"); },
  };
}
