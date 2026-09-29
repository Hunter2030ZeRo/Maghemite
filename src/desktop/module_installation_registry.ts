import { join } from "node:path";
import type { Capability } from "../modules/host/manifest.ts";
import { APP_METHODS } from "../../modules-sdk/js/app.ts";
import { digest, slotId } from "../modules/host/aot-schema.ts";
import {
  readBounded,
  regularPath,
  removeOwned,
  syncDirectory,
  writeSynced,
} from "../modules/host/aot-files.ts";
import {
  INSTALLATION_LIMITS,
  InstallationError,
  type InstallationSnapshot,
} from "../shared/module_installations.ts";

export type InstalledRecord = {
  id: string;
  slot: string;
  grants: Capability[];
  enabled: boolean;
  /** Absent only on preserved legacy records awaiting explicit maintenance. */
  artifactSetId?: string | null;
};
export type InstallationOperation = {
  snapshot: InstallationSnapshot;
  /** Canonical request identity survives token consumption and process restart. */
  input: string;
  slot: string;
};
export type InstallationRegistry = {
  schemaVersion: 2;
  records: InstalledRecord[];
  activeOperation: InstallationOperation | null;
  outcomes: InstallationOperation[];
};

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InstallationError("invalid", message);
}
function object(value: unknown): Record<string, unknown> {
  check(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Invalid module registry object",
  );
  return Object.fromEntries(Object.entries(value));
}
export function operationId(value: unknown): string {
  check(
    typeof value === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        value,
      ),
    "Invalid operation ID",
  );
  return value;
}
export function boundedError(error: unknown): string {
  return String(error).slice(0, INSTALLATION_LIMITS.errorCharacters);
}
function record(input: unknown): InstalledRecord {
  const value = object(input);
  check(
    typeof value.id === "string" &&
      /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(value.id) && value.id.length <= 128,
    "Invalid installed module identity",
  );
  check(typeof value.slot === "string", "Invalid installed slot");
  slotId(value.slot);
  check(typeof value.enabled === "boolean", "Invalid installed enabled state");
  const grants = parseGrants(value.grants);
  if (value.artifactSetId !== undefined && value.artifactSetId !== null) {
    digest(value.artifactSetId);
  }
  check(
    value.artifactSetId === undefined || value.artifactSetId === null ||
      typeof value.artifactSetId === "string",
    "Invalid artifact reference",
  );
  return {
    id: value.id,
    slot: value.slot,
    grants,
    enabled: value.enabled,
    ...(value.artifactSetId === undefined
      ? {}
      : { artifactSetId: value.artifactSetId }),
  };
}
export function parseGrants(input: unknown): Capability[] {
  check(Array.isArray(input), "Grant only declared module permissions");
  const capabilities: readonly Capability[] = [
    "log",
    "tasks.progress",
    "tasks.run-worker",
    "process.execute",
    ...Object.values(APP_METHODS),
  ];
  const values: Capability[] = [];
  for (const value of input) {
    const capability = capabilities.find((item) => item === value);
    check(
      capability && !values.includes(capability),
      "Grant only declared module permissions",
    );
    values.push(capability);
  }
  return values.sort();
}
function operation(input: unknown): InstallationOperation {
  const value = object(input), snapshot = object(value.snapshot);
  const id = operationId(snapshot.id);
  check(
    typeof snapshot.moduleId === "string" && snapshot.moduleId.length <= 128,
    "Invalid operation module",
  );
  check(
    snapshot.kind === "install" || snapshot.kind === "maintenance",
    "Invalid operation kind",
  );
  check(
    snapshot.phase === "queued" || snapshot.phase === "preparing" ||
      snapshot.phase === "committing" ||
      snapshot.phase === "succeeded" || snapshot.phase === "failed" ||
      snapshot.phase === "cancelled",
    "Invalid operation phase",
  );
  check(
    typeof snapshot.completedTargets === "number" &&
      Number.isSafeInteger(snapshot.completedTargets) &&
      snapshot.completedTargets >= 0,
    "Invalid completed targets",
  );
  check(
    typeof snapshot.totalTargets === "number" &&
      Number.isSafeInteger(snapshot.totalTargets) &&
      snapshot.totalTargets >= snapshot.completedTargets &&
      snapshot.totalTargets <= 3,
    "Invalid total targets",
  );
  check(
    typeof snapshot.revision === "number" &&
      Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 1,
    "Invalid revision",
  );
  check(
    typeof snapshot.committed === "boolean" &&
      (snapshot.committed === (snapshot.phase === "succeeded")),
    "Invalid committed outcome",
  );
  check(
    snapshot.error === null ||
      (typeof snapshot.error === "string" &&
        snapshot.error.length <= INSTALLATION_LIMITS.errorCharacters),
    "Invalid operation error",
  );
  check(
    typeof value.input === "string" && value.input.length <= 4096,
    "Invalid operation request",
  );
  check(typeof value.slot === "string", "Invalid operation slot");
  slotId(value.slot);
  return {
    input: value.input,
    slot: value.slot,
    snapshot: {
      id,
      moduleId: snapshot.moduleId,
      kind: snapshot.kind,
      phase: snapshot.phase,
      completedTargets: snapshot.completedTargets,
      totalTargets: snapshot.totalTargets,
      revision: snapshot.revision,
      committed: snapshot.committed,
      error: snapshot.error,
    },
  };
}
export function parseRegistry(input: unknown): InstallationRegistry {
  const value = Array.isArray(input)
    ? { schemaVersion: 2, records: input, activeOperation: null, outcomes: [] }
    : object(input);
  check(
    value.schemaVersion === 2 && Array.isArray(value.records) &&
      value.records.length <= INSTALLATION_LIMITS.records,
    "Invalid module registry",
  );
  const records = value.records.map(record);
  check(
    new Set(records.map((r) => r.id)).size === records.length &&
      new Set(records.map((r) => r.slot)).size === records.length,
    "Duplicate installed identity",
  );
  check(
    Array.isArray(value.outcomes) &&
      value.outcomes.length <= INSTALLATION_LIMITS.outcomes,
    "Invalid operation outcomes",
  );
  const outcomes = value.outcomes.map(operation);
  check(outcomes.every((o) => terminal(o.snapshot)), "Nonterminal outcome");
  const activeOperation = value.activeOperation === null
    ? null
    : operation(value.activeOperation);
  check(
    !activeOperation || !terminal(activeOperation.snapshot),
    "Terminal active operation",
  );
  const ids = [
    ...outcomes.map((o) => o.snapshot.id),
    ...(activeOperation ? [activeOperation.snapshot.id] : []),
  ];
  check(new Set(ids).size === ids.length, "Duplicate operation identity");
  return { schemaVersion: 2, records, activeOperation, outcomes };
}
export function terminal(snapshot: InstallationSnapshot): boolean {
  return ["succeeded", "failed", "cancelled"].includes(snapshot.phase);
}

/** Owns the single durable commit point, including when parent sync later fails. */
export class RegistryFile {
  value: InstallationRegistry = {
    schemaVersion: 2,
    records: [],
    activeOperation: null,
    outcomes: [],
  };
  constructor(readonly directory: string) {}
  async read(): Promise<void> {
    const path = join(this.directory, "installed.json");
    try {
      await regularPath(this.directory, path);
      const bytes = await readBounded(path, INSTALLATION_LIMITS.registryBytes);
      this.value = parseRegistry(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  async publish(
    next: InstallationRegistry,
    boundary: { beforeRename?: () => Promise<void>; renamed?: () => void } = {},
  ): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify(parseRegistry(next)));
    check(
      bytes.length <= INSTALLATION_LIMITS.registryBytes,
      "Module registry too large",
    );
    const path = join(this.directory, "installed.json");
    const temp = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      await writeSynced(temp, bytes);
      await boundary.beforeRename?.();
      await Deno.rename(temp, path);
      this.value = next;
      try {
        boundary.renamed?.();
      } finally {
        await syncDirectory(this.directory);
      }
    } finally {
      await removeOwned(temp);
    }
  }
}
