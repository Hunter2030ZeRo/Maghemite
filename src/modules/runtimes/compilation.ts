/** Native-owned marker emitted after compile workers join, before any guest runs. */
export const COMPILATION_COMPLETE = "\x1eMAGHEMITE_COMPILED_V1\n";
/** Native-owned marker emitted after verified AOT deserialization releases its buffer. */
export const AOT_LOAD_COMPLETE = "\x1eMAGHEMITE_LOADED_V1\n";

class NativeStartupSignal {
  #tail = "";
  #done = Promise.withResolvers<void>();
  constructor(
    private readonly marker: string,
    private readonly timeoutMessage: string,
  ) {
    // A child can fail before its caller starts waiting.
    void this.#done.promise.catch(() => {});
  }
  consume(bytes: Uint8Array) {
    this.#tail += new TextDecoder().decode(bytes);
    if (this.#tail.includes(this.marker)) this.#done.resolve();
    this.#tail = this.#tail.slice(-this.marker.length);
  }
  fail(error: Error) {
    this.#done.reject(error);
  }
  async wait(signal: AbortSignal, timeoutMs = 30_000) {
    signal.throwIfAborted();
    const cancelled = Promise.withResolvers<never>();
    const abort = () => cancelled.reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() =>
      cancelled.reject(
        new Error(this.timeoutMessage),
      ), timeoutMs);
    try {
      await Promise.race([this.#done.promise, cancelled.promise]);
      signal.throwIfAborted();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
}

export class CompilationSignal extends NativeStartupSignal {
  constructor() {
    super(
      COMPILATION_COMPLETE,
      "WASM compilation startup timed out; check resource pressure and rebuild the native host",
    );
  }
}

export class AotLoadSignal extends NativeStartupSignal {
  constructor() {
    super(
      AOT_LOAD_COMPLETE,
      "WASM artifact loading timed out; check artifact integrity and resource pressure",
    );
  }
}
