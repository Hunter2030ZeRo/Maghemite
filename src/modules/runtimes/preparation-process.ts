import { AotError } from "../../shared/module_aot.ts";
import type { PreparationRequest, ResourceAdmission } from "../host/resources.ts";
import { frame, frames } from "./protocol.ts";

export class PreparationTeardownError extends AotError {
  constructor() {
    super("ownership", "Native preparation did not drain; ownership is retained");
  }
}

/** A deadline rejects the caller, never releases a still-live producer's lease. */
export async function drainedWithin<T>(work: Promise<T>): Promise<T> {
  const deadline = AbortSignal.timeout(10_000);
  return await interrupted(work, deadline, () => new PreparationTeardownError());
}

export async function interrupted<T>(
  work: Promise<T>,
  signal: AbortSignal,
  reason = () => signal.reason,
): Promise<T> {
  const aborted = Promise.withResolvers<never>();
  const abort = () => aborted.reject(reason());
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await Promise.race([work, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export interface NativePreparationRun {
  readonly attribution: PreparationRequest;
  readonly args: readonly string[];
  readonly signal: AbortSignal;
  readonly receive: (
    value: Record<string, unknown>,
    send: (value: unknown) => Promise<void>,
    pid: number,
  ) => Promise<void>;
}

/** One owner of each child and its sole stdin writer, status and both drains. */
export class PreparationProcesses {
  #draining = new Set<Promise<void>>();
  constructor(
    readonly executable: string,
    readonly resources: ResourceAdmission,
  ) {}

  async drain(): Promise<void> {
    await drainedWithin(Promise.all([...this.#draining]));
  }

  async run(request: NativePreparationRun): Promise<void> {
    const lease = await this.resources.acquirePreparation(request.attribution, request.signal);
    let child: Deno.ChildProcess;
    try {
      request.signal.throwIfAborted();
      child = new Deno.Command(this.executable, {
        args: [...request.args], clearEnv: true,
        stdin: "piped", stdout: "piped", stderr: "piped",
      }).spawn();
    } catch (error) {
      lease.release();
      throw error;
    }
    const writer = child.stdin.getWriter();
    const stopped = new AbortController();
    const unexpectedExit = new AotError("unavailable", "Native producer exited during a host callback");
    let exited = false;
    let failure: unknown;
    let diagnostic = "";
    const termination = Promise.withResolvers<void>();
    const kill = (error: unknown) => {
      failure ??= error;
      stopped.abort(error);
      if (!exited) {
        try {
          child.kill("SIGKILL");
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) failure = error;
        }
      }
      termination.resolve();
    };
    const abort = () => kill(request.signal.reason);
    request.signal.addEventListener("abort", abort, { once: true });
    const status = child.status.then((status) => {
      exited = true;
      // A failed child cannot wait for a host observer to release its barrier.
      // Successful exit is different: info may still be buffered on stdout.
      if (!status.success) stopped.abort(unexpectedExit);
      termination.resolve();
      return status;
    });
    const stderr = (async () => {
      for await (const bytes of child.stderr) {
        diagnostic += new TextDecoder().decode(bytes).slice(0, Math.max(0, 4096 - diagnostic.length));
      }
    })().catch(kill);
    const stdout = (async () => {
      for await (const value of frames(child.stdout)) {
        if (failure !== undefined || stopped.signal.aborted) continue;
        try {
          await interrupted(request.receive(value, (value) => {
            stopped.signal.throwIfAborted();
            return writer.write(frame(value));
          }, child.pid), stopped.signal);
        } catch (error) {
          kill(error);
        }
      }
    })().catch(kill);
    const stdin = status.then(async () => {
      try {
        await writer.close();
      } catch (error) {
        // A dead child closes its read end before we close the sole writer.
        if (!(error instanceof Deno.errors.BrokenPipe) && !(error instanceof TypeError)) throw error;
      } finally {
        writer.releaseLock();
      }
    }).catch(kill);
    const drained = Promise.all([status, stdout, stderr, stdin]).then(() => {
      lease.release();
      request.signal.removeEventListener("abort", abort);
      this.#draining.delete(drained);
    });
    this.#draining.add(drained);
    lease.attach(child.pid);
    if (request.signal.aborted) abort();
    // A teardown deadline starts only after kill/exit, never during compilation.
    await Promise.race([
      drained,
      termination.promise.then(() => drainedWithin(drained)),
    ]);
    request.signal.throwIfAborted();
    if (failure !== undefined && failure !== unexpectedExit) throw failure;
    const result = await status;
    if (!result.success) {
      throw new AotError("unavailable", `Native preparation failed (${result.code}): ${diagnostic}`);
    }
  }
}
