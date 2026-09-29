/** Schema shared with the native producer. Serialized objects are local install data. */
export const AOT_LIMITS = {
  descriptor: 64 * 1024,
  component: 64 * 1024 * 1024,
  tool: 128 * 1024 * 1024,
  object: 1024 * 1024 * 1024,
  generation: 3 * 1024 * 1024 * 1024,
} as const;

export interface ArtifactProducer {
  readonly identity: string;
  readonly wasmtimeVersion: "49.0.1";
  readonly recipeVersion: 1;
  readonly target: string;
  readonly cpuPolicy: "host-native";
  readonly compilationFingerprint: string;
}

export type ArtifactBinding =
  | {
    readonly kind: "component-entry";
    readonly toolId: null;
    readonly format: "component";
    readonly abi: "component-async-v1" | "component-sync-v1";
  }
  | {
    readonly kind: "wasi-tool";
    readonly toolId: string;
    readonly format: "core-module";
    readonly abi: "wasi-p1-blocking-v1" | "wasi-p1-cooperative-v1";
  };

export type ArtifactSource = ArtifactBinding & {
  readonly sourcePath: string;
  readonly sourceSize: number;
  readonly sourceSha256: string;
};

export type ArtifactTarget = ArtifactSource & {
  readonly producer: ArtifactProducer;
  readonly artifact: {
    readonly file: string;
    readonly size: number;
    readonly sha256: string;
  };
};

export interface ArtifactDescriptor {
  readonly schemaVersion: 1;
  readonly slot: string;
  readonly moduleId: string;
  readonly moduleVersion: string;
  readonly manifestSha256: string;
  readonly targets: readonly ArtifactTarget[];
}

export type AotErrorCode =
  | "invalid"
  | "integrity"
  | "unavailable"
  | "ownership"
  | "in-use";

export class AotError extends Error {
  constructor(readonly code: AotErrorCode, message: string) {
    super(message);
    this.name = "AotError";
  }
}
