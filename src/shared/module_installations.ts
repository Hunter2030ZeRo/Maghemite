/** Public reconnectable operation state. Revisions increase on real changes. */
export type InstallationSnapshot = {
  id: string;
  moduleId: string;
  kind: "install" | "maintenance";
  phase:
    | "queued"
    | "preparing"
    | "committing"
    | "succeeded"
    | "failed"
    | "cancelled";
  completedTargets: number;
  totalTargets: number;
  revision: number;
  committed: boolean;
  error: string | null;
};

export type InstallationState = {
  activeOperation: InstallationSnapshot | null;
  outcomes: InstallationSnapshot[];
  maintenance: { id: string; error: string }[];
};

export const INSTALLATION_LIMITS = {
  records: 100,
  outcomes: 16,
  registryBytes: 256 * 1024,
  errorCharacters: 1024,
  subscriptionMs: 25_000,
} as const;

export class InstallationError extends Error {
  readonly code:
    | "invalid"
    | "busy"
    | "conflict"
    | "closed"
    | "unknown"
    | "maintenance";
  constructor(
    code: InstallationError["code"],
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "InstallationError";
  }
}
