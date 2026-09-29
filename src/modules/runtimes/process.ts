import { frame, frames } from "./protocol.ts";
import { AotLoadSignal, CompilationSignal } from "./compilation.ts";

export type EventHandler = (
  method: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<unknown>;
type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  events: EventHandler;
};

/** One lifecycle call at a time; owned by one module, never trusted for identity. */
export class ModuleProcess {
  readonly #child: Deno.ChildProcess;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  #pending?: Pending;
  #call = 0;
  #closed = false;
  #events = new Map<number, () => void>();
  #eventTasks = new Set<Promise<void>>();
  #lastEvent = 0;
  #writes: Promise<void> = Promise.resolve();
  #reading: Promise<void>;
  #stderr: Promise<void>;
  #diagnostic = "";
  readonly compilation = new CompilationSignal();
  readonly loaded = new AotLoadSignal();
  readonly exited: Promise<Error>;
  #failure = new Error("Module process exited");

  constructor(command: Deno.Command) {
    this.#child = command.spawn();
    this.#writer = this.#child.stdin.getWriter();
    this.#stderr = this.#drainStderr();
    this.#reading = this.#read();
    this.exited = Promise.all([this.#child.status, this.#reading, this.#stderr])
      .then(() => this.#failure);
    // Read stdout through EOF before observing exit: a final response may
    // still be buffered when the child status resolves.
  }
  get pid() {
    return this.#child.pid;
  }

  async #drainStderr(): Promise<void> {
    try {
      for await (const bytes of this.#child.stderr) {
        this.compilation.consume(bytes);
        this.loaded.consume(bytes);
        if (this.#diagnostic.length < 4096) {
          this.#diagnostic += new TextDecoder().decode(bytes).slice(
            0,
            4096 - this.#diagnostic.length,
          );
        }
      }
    } catch { /* Termination may close the pipe. */ }
  }

  #send(value: unknown): Promise<void> {
    return this.#sendBytes(frame(value));
  }

  #sendBytes(bytes: Uint8Array): Promise<void> {
    const write = this.#writes.then(() => this.#writer.write(bytes));
    this.#writes = write.catch(() => {});
    return write;
  }

  async #read(): Promise<void> {
    try {
      for await (const message of frames(this.#child.stdout)) {
        const pending = this.#pending;
        if (!pending) throw new Error("Unsolicited module message");
        if (message.type === "response") {
          if (message.id !== this.#call || typeof message.ok !== "boolean") {
            throw new Error("Invalid module response");
          }
          if (message.ok && this.#events.size) {
            throw new Error("Module returned with unacknowledged host calls");
          }
          if (message.ok) pending.resolve(message.value);
          else {
            // An uncaught guest error may abandon a concurrent group (e.g.
            // Promise.all). Preserve that error and cancel every owned service.
            this.#fail(
              new Error(
                typeof message.error === "string"
                  ? message.error.slice(0, 4096)
                  : "Module failed",
              ),
            );
          }
          this.#pending = undefined;
        } else if (message.type === "event") {
          if (
            message.call !== this.#call || !Number.isSafeInteger(message.id) ||
            (message.id as number) <= this.#lastEvent ||
            typeof message.method !== "string"
          ) throw new Error("Invalid module event");
          // Also bound acknowledgements waiting on stdin. The allowance covers
          // a child receiving an ack before its write promise resolves here.
          if (this.#events.size >= 8 || this.#eventTasks.size >= 16) {
            throw new Error("Too many host calls");
          }
          this.#lastEvent = message.id as number;
          const task = this.#event(message, pending.events);
          this.#eventTasks.add(task);
          void task.then(
            () => this.#eventTasks.delete(task),
            (error) => {
              this.#eventTasks.delete(task);
              this.#fail(
                error instanceof Error
                  ? error
                  : new Error("Host event dispatch failed"),
              );
            },
          );
        } else throw new Error("Unknown module message");
      }
      this.#fail(
        new Error(
          `Module transport closed${
            this.#diagnostic ? `: ${this.#diagnostic}` : ""
          }`,
        ),
      );
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async #event(message: Record<string, unknown>, handler: EventHandler) {
    const id = message.id as number;
    const cancelled = Promise.withResolvers<never>();
    const scope = new AbortController();
    this.#events.set(id, () => {
      scope.abort();
      cancelled.reject(new Error("Module closed"));
    });
    let ack: Record<string, unknown> = { type: "ack", id, ok: true };
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => {
          if (this.#closed) throw new Error("Module closed");
          return handler(
            message.method as string,
            message.payload,
            scope.signal,
          );
        }),
        cancelled.promise,
      ]);
      // Validate before publishing: oversized/non-JSON replies fail this event,
      // not the entire transport or an unrelated lifecycle response.
      const candidate = { ...ack, value: value ?? null };
      frame(candidate);
      ack = candidate;
    } catch (error) {
      ack = { type: "ack", id, ok: false, error: String(error).slice(0, 2048) };
    }
    scope.abort();
    // The child can respond as soon as it receives the ack, before write()
    // resolves. Clear consumed events before publishing their acknowledgements.
    this.#events.delete(id);
    if (!this.#closed) {
      try {
        await this.#send(ack);
      } catch (error) {
        this.#fail(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failure = error;
    this.compilation.fail(error);
    this.loaded.fail(error);
    for (const cancel of this.#events.values()) cancel();
    this.#events.clear();
    this.#pending?.reject(error);
    this.#pending = undefined;
    try {
      this.#child.kill("SIGKILL");
    } catch { /* Already exited. */ }
  }

  async call(
    method: string,
    parameters: Record<string, unknown>,
    events: EventHandler,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    if (this.#closed) throw new Error("Module process is closed");
    if (this.#pending) throw new Error("Module is busy");
    const id = ++this.#call;
    // Validate before changing lifecycle state or installing timers.
    const bytes = frame({ type: "request", id, method, ...parameters });
    const result = new Promise<unknown>((resolve, reject) => {
      this.#pending = { resolve, reject, events };
    });
    const abort = () =>
      this.#fail(
        signal?.reason instanceof Error && signal.reason.name !== "AbortError"
          ? signal.reason
          : new DOMException("Module call cancelled", "AbortError"),
      );
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => this.#fail(new Error("Module call timed out")),
      timeoutMs,
    );
    try {
      void this.#sendBytes(bytes).catch((
        e,
      ) => this.#fail(e));
      return await result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  async close(): Promise<void> {
    this.#fail(new Error("Module closed"));
    await this.#writer.abort().catch(() => {});
    await this.#child.status.catch(() => {});
    await this.#stderr;
    await this.#reading;
    await Promise.allSettled([...this.#eventTasks]);
  }
}
