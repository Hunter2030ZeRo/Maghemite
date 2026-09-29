/** Bytes are bytes, not KiB. null means unavailable, never a measured zero. */
export type ModuleState =
  | "registered"
  | "activating"
  | "active"
  | "suspending"
  | "suspended"
  | "restarting"
  | "disabled"
  | "failed";

export type ResourceKind =
  | "deno"
  | "wasm-standard"
  | "wasm-compute"
  | "wasi-tool";
export type ResourceOperation =
  | "runtime-start"
  | "preparation"
  | "artifact-load";
export type ProcessResource = {
  id: string;
  moduleId: string;
  kind: ResourceKind | "aot-preparation";
  operation: ResourceOperation;
  operationId: string | null;
  generationId: string | null;
  compilerPermit: boolean;
  worker: boolean;
  phase: "starting" | "preparing" | "loading" | "running";
  pid: number | null;
  reservedBytes: number;
  rssBytes: number | null;
};
export type ResourceSnapshot = {
  scope: "owned-process-tree-and-reported-reservations";
  sampledAt: number;
  budgetBytes: number;
  coreRssBytes: number;
  ownedTree: {
    source: "linux-proc" | "unavailable";
    complete: boolean;
    processCount: number;
    rssBytes: number | null;
    knownRssBytes: number;
  };
  observedModuleRssBytes: number | null;
  reservedBytes: number;
  chargedBytes: number;
  compilation: { active: number; limit: number; queued: number };
  queued: number;
  queueLimit: number;
  processes: ProcessResource[];
  external: HostResourceUsage[];
};
/** Supply the owning PID to deduplicate RSS/reservations against the owned tree. */
export type HostResourceUsage = {
  id: string;
  label: string;
  rssBytes: number | null;
  reservedBytes: number;
  diskBytes: number | null;
  pid?: number | null;
  /** Logical cache bytes, not an RSS measurement. */
  retainedBytes?: number;
  limitBytes?: number;
  reportedAt?: number;
};
export type ModuleResources = {
  processes: ProcessResource[];
  queued: number;
  rssBytes: number | null;
  reservedBytes: number;
  installedAotBytes: number | null;
  limits: {
    linearMemoryBytes: number | null;
    memories: number | null;
    oldSpaceBytes: number | null;
    wasiToolMemoryBytes: number | null;
  };
};
export type ModuleStatus = {
  id: string;
  version: string;
  runtime: string;
  capabilities: string[];
  grants: string[];
  managed: boolean;
  enabled: boolean;
  state: ModuleState;
  busy: boolean;
  error: string | null;
  commands: number;
  themes: number;
  languageFeatures: string[];
  resources: ModuleResources;
};
export type ModulePage = {
  items: ModuleStatus[];
  nextOffset: number | null;
  resources: ResourceSnapshot;
  diskUsage: {
    installedAotBytes: number | null;
    legacyCacheBytes: number | null;
  };
};
