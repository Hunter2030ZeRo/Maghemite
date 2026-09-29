import { deepStrictEqual as eq } from "node:assert/strict";
import {
  type LoadLease,
  type PreparationLease,
  ResourceAdmission,
} from "../resources.ts";

export const WAIT_TIMEOUT_MS = 2000;
export type ProbeFault =
  | "none"
  | "ready-timeout"
  | "assert-after-ready"
  | "exit-timeout";
export type Releasable = PreparationLease | LoadLease;
export type Outcome<T> =
  | { readonly kind: "fulfilled"; readonly value: T }
  | { readonly kind: "rejected"; readonly reason: unknown };
export type BarrierChild = {
  readonly process: Deno.ChildProcess;
  readonly input: WritableStreamDefaultWriter<Uint8Array>;
  readonly output: ReadableStreamDefaultReader<Uint8Array>;
  readonly stderr: Promise<string>;
  status: Deno.CommandStatus | null;
  stderrText: string | null;
  inputClosed: boolean;
  outputCancelled: boolean;
  cleaned: boolean;
};

export function parseFault(value: string | undefined): ProbeFault {
  switch (value) {
    case undefined:
    case "none":
      return "none";
    case "ready-timeout":
    case "assert-after-ready":
    case "exit-timeout":
      return value;
    default:
      throw new TypeError(`Unknown probe fault: ${value}`);
  }
}

export function outcome<T>(operation: Promise<T>): Promise<Outcome<T>> {
  return operation.then(
    (value) => ({ kind: "fulfilled", value }),
    (reason: unknown) => ({ kind: "rejected", reason }),
  );
}

export async function bounded<T>(
  operation: Promise<T>,
  label: string,
): Promise<T> {
  const signal = AbortSignal.timeout(WAIT_TIMEOUT_MS);
  const timeout = Promise.withResolvers<never>();
  const abort = () =>
    timeout.reject(new DOMException(`${label} timed out`, "TimeoutError"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([operation, timeout.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export function changed(
  resources: ResourceAdmission,
  predicate: () => boolean,
): Promise<void> {
  const signal = AbortSignal.timeout(WAIT_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      resources.removeEventListener("change", check);
      signal.removeEventListener("abort", abort);
    };
    const check = () => {
      if (!predicate()) return;
      cleanup();
      resolve();
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    resources.addEventListener("change", check);
    signal.addEventListener("abort", abort, { once: true });
    check();
  });
}

export function spawnBarrierChild(emitReady: boolean): BarrierChild {
  const childSource = emitReady
    ? `
const bytes = new TextEncoder().encode("READY\\n");
await Deno.stdout.write(bytes);
for await (const _chunk of Deno.stdin.readable) {}
`
    : `for await (const _chunk of Deno.stdin.readable) {}`;
  const process = new Deno.Command(Deno.execPath(), {
    args: ["eval", childSource],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  return {
    process,
    input: process.stdin.getWriter(),
    output: process.stdout.getReader(),
    stderr: new Response(process.stderr).text(),
    status: null,
    stderrText: null,
    inputClosed: false,
    outputCancelled: false,
    cleaned: false,
  };
}

export async function ready(child: BarrierChild): Promise<void> {
  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes("\n")) {
    const chunk = await bounded(
      child.output.read(),
      `child ${child.process.pid} readiness`,
    );
    if (chunk.done) throw new TypeError("Barrier child exited before ready");
    output += decoder.decode(chunk.value, { stream: true });
  }
  eq(output, "READY\n");
}

export async function cleanupChild(
  child: BarrierChild,
): Promise<{ readonly status: Deno.CommandStatus; readonly stderr: string }> {
  if (child.cleaned && child.status && child.stderrText !== null) {
    return { status: child.status, stderr: child.stderrText };
  }
  const failures: unknown[] = [];
  let closeOperation: Promise<void> | null = null;
  if (!child.inputClosed) {
    closeOperation = child.input.close();
    const closed = await outcome(bounded(
      closeOperation,
      `child ${child.process.pid} stdin close`,
    ));
    if (closed.kind === "fulfilled") {
      child.inputClosed = true;
      child.input.releaseLock();
    }
  }
  if (!child.status) {
    let status = await outcome(bounded(
      child.process.status,
      `child ${child.process.pid} status`,
    ));
    if (status.kind === "rejected") {
      const killed = await outcome(
        Promise.resolve().then(() => child.process.kill("SIGKILL")),
      );
      status = await outcome(bounded(
        child.process.status,
        `child ${child.process.pid} killed status`,
      ));
      if (status.kind === "rejected" && killed.kind === "rejected") {
        failures.push(killed.reason);
      }
    }
    if (status.kind === "fulfilled") child.status = status.value;
    else failures.push(status.reason);
  }
  if (!child.inputClosed && closeOperation) {
    const closed = await outcome(bounded(
      closeOperation,
      `child ${child.process.pid} stdin close after exit`,
    ));
    if (closed.kind === "fulfilled") {
      child.inputClosed = true;
      child.input.releaseLock();
    } else failures.push(closed.reason);
  }
  if (!child.outputCancelled) {
    const cancelled = await outcome(bounded(
      child.output.cancel(),
      `child ${child.process.pid} stdout cancel`,
    ));
    if (cancelled.kind === "fulfilled") {
      child.outputCancelled = true;
      child.output.releaseLock();
    } else failures.push(cancelled.reason);
  }
  if (child.stderrText === null) {
    const stderr = await outcome(bounded(
      child.stderr,
      `child ${child.process.pid} stderr drain`,
    ));
    if (stderr.kind === "fulfilled") child.stderrText = stderr.value;
    else failures.push(stderr.reason);
  }
  if (failures.length) {
    throw new AggregateError(
      failures,
      `Failed to clean child ${child.process.pid}`,
    );
  }
  if (!child.status || child.stderrText === null) {
    throw new TypeError(`Incomplete cleanup for child ${child.process.pid}`);
  }
  child.cleaned = true;
  return { status: child.status, stderr: child.stderrText };
}

export async function stopChild(child: BarrierChild): Promise<void> {
  const result = await cleanupChild(child);
  eq(result.status.success, true);
  eq(result.stderr, "");
}
