/** Typed Deno binding for the Maghemite Rust core ABI (version 1). */

import type { Json } from "../../modules-sdk/js/mod.ts";
import { registerNativeOwnedProcessUsage } from "../modules/host/process_usage.ts";
import {
  ownedProcessUsageSymbols,
  sampleNativeOwnedProcesses,
} from "./owned_process_usage.ts";

const symbols = {
  ...ownedProcessUsageSymbols,
  mg_workspace_request: {
    parameters: ["u64", "buffer", "usize", "buffer", "usize", "buffer"],
    result: "i32",
    nonblocking: true,
  },
  mg_core_abi_version: { parameters: [], result: "u32" },
  mg_workspace_open: {
    parameters: ["buffer", "usize", "buffer", "usize", "buffer"],
    result: "i32",
  },
  mg_workspace_close: { parameters: ["u64"], result: "i32" },
  mg_index_start: { parameters: ["u64", "buffer"], result: "i32" },
  mg_index_refresh_start: {
    parameters: ["u64", "buffer", "usize", "buffer"],
    result: "i32",
  },
  mg_index_status: { parameters: ["u64", "buffer"], result: "i32" },
  mg_index_cancel: { parameters: ["u64"], result: "i32" },
  mg_index_release: { parameters: ["u64"], result: "i32" },
  mg_index_error: {
    parameters: ["u64", "buffer", "usize", "buffer"],
    result: "i32",
  },
  mg_core_shutdown: { parameters: [], result: "i32" },
} as const;

const errorNames: Record<number, string> = {
  1: "Invalid argument",
  2: "Unknown workspace",
  3: "Unknown index job",
  4: "An index is already running",
  5: "Resource is busy",
  6: "Filesystem error",
  7: "Index database error",
  8: "Native core error",
  9: "Output buffer is too small",
  10: "Index cancelled",
};

export type IndexPhase =
  | "queued"
  | "running"
  | "completed"
  | "cancelled"
  | "failed";

const phases: IndexPhase[] = [
  "queued",
  "running",
  "completed",
  "cancelled",
  "failed",
];

export interface IndexStatus {
  phase: IndexPhase;
  scanned: bigint;
  added: bigint;
  updated: bigint;
  removed: bigint;
  bytes: bigint;
  revision: bigint;
  errorCode: number;
}

export class CoreStatusError extends Error {
  constructor(public readonly code: number) {
    super(errorNames[code] ?? `Unknown native status code ${code}`);
    this.name = "CoreStatusError";
  }
}

export class CoreBridge {
  private closed = false;
  private requests = 0;
  private readonly unregisterOwnedProcessUsage: () => void;

  private constructor(
    private readonly library: Deno.DynamicLibrary<typeof symbols>,
  ) {
    this.unregisterOwnedProcessUsage = registerNativeOwnedProcessUsage(
      () => this.sampleOwnedProcesses(),
    );
  }

  static open(path: string | URL): CoreBridge {
    const library = Deno.dlopen(path, symbols);
    if (library.symbols.mg_core_abi_version() !== 1) {
      library.close();
      throw new Error("Incompatible Maghemite native core ABI");
    }
    return new CoreBridge(library);
  }

  private check(code: number): void {
    if (code !== 0) throw new CoreStatusError(code);
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Maghemite native core is closed");
  }

  private async sampleOwnedProcesses() {
    this.ensureOpen();
    this.requests++;
    try {
      return await sampleNativeOwnedProcesses(
        (output, capacity, meta) =>
          this.library.symbols.mg_owned_process_usage(
            output,
            capacity,
            meta,
          ),
      );
    } finally {
      this.requests--;
    }
  }

  openWorkspace(root: string, databasePath: string): bigint {
    this.ensureOpen();
    const rootBytes = new TextEncoder().encode(root);
    const databaseBytes = new TextEncoder().encode(databasePath);
    const output = new BigUint64Array(1);
    this.check(this.library.symbols.mg_workspace_open(
      rootBytes,
      BigInt(rootBytes.length),
      databaseBytes,
      BigInt(databaseBytes.length),
      output,
    ));
    return output[0];
  }

  async request(
    workspaceId: bigint,
    method: string,
    parameters: Json,
  ): Promise<Json> {
    this.ensureOpen();
    const input = new TextEncoder().encode(
      JSON.stringify({ method, parameters }),
    );
    if (input.length > 65536) throw new Error("Native request exceeds limit");
    const output = new Uint8Array(65536), length = new BigUint64Array(1);
    this.requests++;
    try {
      this.check(
        await this.library.symbols.mg_workspace_request(
          workspaceId,
          input,
          BigInt(input.length),
          output,
          BigInt(output.length),
          length,
        ),
      );
    } finally {
      this.requests--;
    }
    const response = JSON.parse(
      new TextDecoder().decode(output.subarray(0, Number(length[0]))),
    );
    if (!response.ok) throw new Error(response.error);
    return response.value;
  }

  closeWorkspace(workspaceId: bigint): void {
    this.ensureOpen();
    this.check(this.library.symbols.mg_workspace_close(workspaceId));
  }

  startIndex(workspaceId: bigint): bigint {
    this.ensureOpen();
    const output = new BigUint64Array(1);
    this.check(this.library.symbols.mg_index_start(workspaceId, output));
    return output[0];
  }

  refreshPaths(workspaceId: bigint, paths: readonly string[]): bigint {
    this.ensureOpen();
    if (
      paths.length === 0 || paths.some((path) => !path || path.includes("\0"))
    ) {
      throw new TypeError("Refresh requires nonempty paths without NUL bytes");
    }
    const encoded = new TextEncoder().encode(paths.join("\0"));
    const output = new BigUint64Array(1);
    this.check(this.library.symbols.mg_index_refresh_start(
      workspaceId,
      encoded,
      BigInt(encoded.length),
      output,
    ));
    return output[0];
  }

  indexStatus(jobId: bigint): IndexStatus {
    this.ensureOpen();
    const output = new BigUint64Array(8);
    this.check(this.library.symbols.mg_index_status(jobId, output));
    const phase = phases[Number(output[0])];
    if (phase === undefined) {
      throw new Error(`Unknown index phase ${output[0]}`);
    }
    return {
      phase,
      scanned: output[1],
      added: output[2],
      updated: output[3],
      removed: output[4],
      bytes: output[5],
      revision: output[6],
      errorCode: Number(output[7]),
    };
  }

  indexError(jobId: bigint): string {
    this.ensureOpen();
    const length = new BigUint64Array(1);
    const empty = new Uint8Array(0);
    const probe = this.library.symbols.mg_index_error(jobId, empty, 0n, length);
    if (probe !== 0 && probe !== 9) this.check(probe);
    if (length[0] === 0n) return "";
    if (length[0] > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Native error message is too large");
    }
    const bytes = new Uint8Array(Number(length[0]));
    this.check(this.library.symbols.mg_index_error(
      jobId,
      bytes,
      BigInt(bytes.length),
      length,
    ));
    return new TextDecoder().decode(bytes);
  }

  cancelIndex(jobId: bigint): void {
    this.ensureOpen();
    this.check(this.library.symbols.mg_index_cancel(jobId));
  }

  releaseIndex(jobId: bigint): void {
    this.ensureOpen();
    this.check(this.library.symbols.mg_index_release(jobId));
  }

  close(): void {
    if (this.closed) return;
    if (this.requests) throw new Error("Native requests are still running");
    // Rust joins all worker threads before the shared library is unloaded.
    this.check(this.library.symbols.mg_core_shutdown());
    this.closed = true;
    this.unregisterOwnedProcessUsage();
    this.library.close();
  }
}
