import type { GenerationPin } from "./aot.ts";
import { AotLoadSignal } from "../runtimes/compilation.ts";
import type { LoadLease } from "./resources.ts";

const CHUNK = 24 * 1024;

/** One native WASI child, including its load reservation and generation pin. */
export class WasiPipe {
  readonly child: Deno.ChildProcess;
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  rest: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  reading = false;
  writing = false;
  closed = false;
  diagnostic = "";
  readonly stderr: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  readonly loaded = new AotLoadSignal();
  #closing?: Promise<void>;

  constructor(
    command: Deno.Command,
    private readonly lease: LoadLease,
    private readonly pin: GenerationPin,
  ) {
    this.child = command.spawn();
    lease.attach(this.child.pid);
    this.writer = this.child.stdin.getWriter();
    this.reader = this.child.stdout.getReader();
    const stderr = this.child.stderr;
    this.stderr = (async () => {
      for await (const bytes of stderr) {
        this.loaded.consume(bytes);
        this.diagnostic = (this.diagnostic + new TextDecoder().decode(bytes))
          .slice(-2048);
      }
    })().catch(() => {});
    void this.child.status.then(async () => {
      await this.stderr;
      this.loaded.fail(
        new Error("WASI startup failed: " + this.diagnostic),
      );
      // Buffered stdout remains readable after the dead child releases ownership.
      this.lease.release();
      this.pin.release();
    });
    this.touch();
  }

  touch(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.close();
    }, 60_000);
    Deno.unrefTimer(this.timer);
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.closed = true;
    this.loaded.fail(new Error("WASI startup cancelled"));
    clearTimeout(this.timer);
    try {
      this.child.kill("SIGKILL");
    } catch { /* Already exited. */ }
    this.#closing = (async () => {
      await this.reader.cancel().catch(() => {});
      await this.writer.abort().catch(() => {});
      await this.child.status;
      await this.stderr;
      this.rest = new Uint8Array(0);
      this.lease.release();
      this.pin.release();
    })();
    return this.#closing;
  }

  async read(): Promise<{ data: string; eof: boolean }> {
    if (this.closed || this.reading) {
      throw new Error("WASI pipe unavailable or busy");
    }
    this.reading = true;
    try {
      if (!this.rest.length) {
        const { value, done } = await this.reader.read();
        if (done) {
          const status = await this.child.status;
          await this.stderr;
          if (!status.success) {
            throw new Error("WASI tool failed: " + this.diagnostic);
          }
          return { data: "", eof: true };
        }
        this.rest = value;
      }
      const data = this.rest.subarray(0, CHUNK);
      const encoded = data.toBase64();
      this.rest = this.rest.subarray(data.length);
      return { data: encoded, eof: false };
    } finally {
      this.reading = false;
    }
  }
}
