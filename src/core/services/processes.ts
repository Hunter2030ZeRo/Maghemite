import type { Json } from "../../../modules-sdk/js/mod.ts";
import { EventHub } from "./events.ts";

export type ToolProfile = {
  id: string;
  kind: "terminal" | "tool" | "formatter" | "linter" | "language" | "debug";
  command: string;
  args?: string[];
  env?: Record<string, string>;
};
export type ProcessReservation = {
  started(pid: number): void;
  release(): void;
};
export type ToolResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  cancelled: boolean;
  complete: boolean;
  truncated: { stdout: boolean; stderr: boolean };
};
export function validateProfiles(input: unknown): ToolProfile[] {
  if (!Array.isArray(input) || input.length > 64) {
    throw new Error("Invalid tool profiles");
  }
  const ids = new Set<string>();
  for (const p of input) {
    if (
      !p || typeof p.id !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/.test(p.id) ||
      ids.has(p.id) ||
      !["terminal", "tool", "formatter", "linter", "language", "debug"]
        .includes(p.kind) ||
      typeof p.command !== "string" || !p.command || p.command.includes("\0") ||
      (p.args !== undefined &&
        (!Array.isArray(p.args) || p.args.length > 64 ||
          p.args.some((s: unknown) =>
            typeof s !== "string" || s.length > 4096 || s.includes("\0")
          ))) ||
      (p.env !== undefined &&
        (typeof p.env !== "object" || p.env === null || Array.isArray(p.env) ||
          Object.entries(p.env).some(([k, v]) =>
            !/^\w+$/.test(k) || typeof v !== "string" || v.includes("\0")
          )))
    ) throw new Error("Invalid tool profile");
    ids.add(p.id);
  }
  return structuredClone(input);
}
/** Bounded output journal; cursors expose dropped output instead of hiding loss. */
export class Journal {
  text = "";
  base = 0;
  constructor(private readonly capacity = 32768) {}
  append(text: string) {
    this.text += text;
    if (this.text.length > this.capacity) {
      let cut = this.text.length - this.capacity;
      if (
        /[\uD800-\uDBFF]/.test(this.text[cut - 1]) &&
        /[\uDC00-\uDFFF]/.test(this.text[cut])
      ) cut++;
      this.text = this.text.slice(cut);
      this.base += cut;
    }
  }
  read(cursor = this.base) {
    const start = Math.min(
      Math.max(cursor, this.base),
      this.base + this.text.length,
    );
    let end = Math.min(start - this.base + 4096, this.text.length);
    if (end < this.text.length && /[\uD800-\uDBFF]/.test(this.text[end - 1])) {
      end--;
    }
    const text = this.text.slice(start - this.base, end);
    return { text, cursor: start + text.length, dropped: cursor < this.base };
  }
}
export abstract class OwnedProcess {
  id = crypto.randomUUID();
  #released = false;
  constructor(
    readonly owner: string,
    readonly profile: ToolProfile,
    private readonly reservation?: ProcessReservation,
  ) {}
  protected started(pid: number) {
    this.reservation?.started(pid);
  }
  protected releaseReservation() {
    if (this.#released) return;
    this.#released = true;
    this.reservation?.release();
  }
  abstract close(): Promise<void>;
}
export class ToolSession extends OwnedProcess {
  readonly output = new Journal();
  readonly errors = new Journal();
  readonly child!: Deno.ChildProcess;
  readonly finished: Promise<void>;
  exitCode: number | null = null;
  #timer!: ReturnType<typeof setTimeout>;
  #readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  #cancelled = false;
  constructor(
    owner: string,
    profile: ToolProfile,
    cwd: string,
    input: string,
    events: EventHub,
    reservation?: ProcessReservation,
  ) {
    super(owner, profile, reservation);
    this.child = new Deno.Command(profile.command, {
      args: profile.args ?? [],
      cwd,
      env: profile.env,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    this.started(this.child.pid);
    this.#timer = setTimeout(() => {
      void this.close();
    }, 60000);
    const consume = async (
      stream: ReadableStream<Uint8Array>,
      journal: Journal,
    ) => {
      const decoder = new TextDecoder(), reader = stream.getReader();
      this.#readers.push(reader);
      for (;;) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        journal.append(decoder.decode(chunk, { stream: true }));
        events.emit("tools.output", { session: this.id }, owner);
      }
      journal.append(decoder.decode());
    };
    const write = (async () => {
      const writer = this.child.stdin.getWriter();
      try {
        await writer.write(new TextEncoder().encode(input));
        await writer.close();
      } catch {
        /* Early process exit closes stdin. */
      } finally {
        writer.releaseLock();
      }
    })();
    this.finished = (async () => {
      try {
        await Promise.all([
          consume(this.child.stdout, this.output),
          consume(this.child.stderr, this.errors),
          write,
        ]);
        this.exitCode = (await this.child.status).code;
      } finally {
        clearTimeout(this.#timer);
        this.releaseReservation();
        events.emit("tools.output", { session: this.id }, owner);
      }
    })();
    void this.finished.catch(() => {});
  }
  async close() {
    if (this.exitCode === null) this.#cancelled = true;
    try {
      this.child.kill("SIGKILL");
    } catch { /* exited */ }
    await Promise.allSettled(this.#readers.map((r) => r.cancel()));
    await this.finished.catch(() => {});
    this.releaseReservation();
  }
  read(cursor?: number) {
    return {
      ...this.output.read(cursor),
      stderr: this.errors.text.slice(-4096),
      stderrTruncated: this.errors.base > 0 ||
        this.errors.text.length > 4096,
      done: this.exitCode !== null,
      exitCode: this.exitCode,
    };
  }
  async result(signal: AbortSignal): Promise<ToolResult> {
    signal.throwIfAborted();
    const abort = () => {
      void this.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await this.finished;
      signal.throwIfAborted();
      if (this.exitCode === null) throw new Error("Tool result unavailable");
      const stdout = this.output.base > 0;
      const stderr = this.errors.base > 0;
      return {
        stdout: this.output.text,
        stderr: this.errors.text,
        exitCode: this.exitCode,
        cancelled: this.#cancelled,
        complete: !stdout && !stderr,
        truncated: { stdout, stderr },
      };
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
}

/** One framed stdio session for LSP (JSON-RPC) or DAP. No raw command execution API. */
export class ProtocolSession extends OwnedProcess {
  readonly child!: Deno.ChildProcess;
  readonly events: { cursor: number; message: Json }[] = [];
  readonly stderr = new Journal();
  #cursor = 0;
  #sequence = 0;
  #closed = false;
  #writes = Promise.resolve();
  #queuedWrites = 0;
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  #pending = new Map<
    number,
    { resolve(v: Json): void; reject(e: Error): void }
  >();
  #incoming = new Map<string | number, string>();
  #reader: Promise<void>;
  #errors: Promise<void>;
  #status: Promise<void>;
  #stdout: ReadableStreamDefaultReader<Uint8Array>;
  #stderr!: ReadableStreamDefaultReader<Uint8Array>;
  exitCode: number | null = null;
  constructor(
    owner: string,
    profile: ToolProfile,
    cwd: string,
    private hub: EventHub,
    reservation?: ProcessReservation,
  ) {
    super(owner, profile, reservation);
    this.child = new Deno.Command(profile.command, {
      args: profile.args ?? [],
      cwd,
      env: profile.env,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    this.started(this.child.pid);
    this.#writer = this.child.stdin.getWriter();
    this.#stdout = this.child.stdout.getReader();
    this.#stderr = this.child.stderr.getReader();
    this.#reader = this.#read().catch((error) => this.#fail(error));
    this.#errors = (async () => {
      const d = new TextDecoder();
      for (;;) {
        const { value, done } = await this.#stderr.read();
        if (done) break;
        this.stderr.append(d.decode(value, { stream: true }));
      }
    })().catch(() => {});
    this.#status = this.child.status.then((status) => {
      this.exitCode = status.code;
      this.#fail(new Error("Protocol process exited"));
    }).catch((error) => this.#fail(error));
  }
  #fail(error: unknown) {
    if (this.#closed) return;
    this.#closed = true;
    for (const p of this.#pending.values()) p.reject(new Error(String(error)));
    this.#pending.clear();
    try {
      this.child.kill("SIGKILL");
    } catch { /* exited */ }
    this.releaseReservation();
    this.hub.emit(`${this.profile.kind}.message`, {
      session: this.id,
      closed: true,
    }, this.owner);
  }
  async send(message: Json) {
    if (this.#closed) throw new Error("Protocol session closed");
    const body = new TextEncoder().encode(JSON.stringify(message));
    if (body.length > 64 * 1024) {
      throw new Error("Protocol message exceeds limit");
    }
    const header = new TextEncoder().encode(
        `Content-Length: ${body.length}\r\n\r\n`,
      ),
      data = new Uint8Array(header.length + body.length);
    data.set(header);
    data.set(body, header.length);
    if (this.#queuedWrites >= 32) {
      throw new Error("Protocol write queue is full");
    }
    this.#queuedWrites++;
    const write = this.#writes.then(() => this.#writer.write(data));
    this.#writes = write.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        write,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error("Protocol write timed out");
            this.#fail(error);
            reject(error);
          }, 20000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.#queuedWrites--;
    }
  }

  async request(
    method: string,
    parameters: Json,
    signal: AbortSignal,
  ): Promise<Json> {
    signal.throwIfAborted();
    if (this.#pending.size >= 16) throw new Error("Too many protocol requests");
    const id = ++this.#sequence, done = Promise.withResolvers<Json>();
    this.#pending.set(id, done);
    void done.promise.catch(() => {});
    const abort = () => {
      done.reject(new Error("Protocol request cancelled"));
      if (this.profile.kind === "language") {
        void this.send({
          jsonrpc: "2.0",
          method: "$/cancelRequest",
          params: { id },
        }).catch(() => {});
      }
    };
    const timer = setTimeout(
      () => done.reject(new Error("Protocol request timed out")),
      20000,
    );
    signal.addEventListener("abort", abort, { once: true });
    try {
      await Promise.race([
        done.promise,
        this.send(
          this.profile.kind === "debug"
            ? {
              seq: id,
              type: "request",
              command: method,
              arguments: parameters,
            }
            : { jsonrpc: "2.0", id, method, params: parameters },
        ),
      ]);
      return await done.promise;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      this.#pending.delete(id);
    }
  }
  async respond(id: string | number, result: Json, error?: string) {
    const command = this.#incoming.get(id);
    if (command === undefined) throw new Error("Unknown server request");
    this.#incoming.delete(id);
    if (this.profile.kind === "debug") {
      return await this.send({
        seq: ++this.#sequence,
        type: "response",
        request_seq: id,
        command,
        success: !error,
        ...(error ? { message: error } : { body: result }),
      });
    }
    await this.send({
      jsonrpc: "2.0",
      id,
      ...(error ? { error: { code: -32000, message: error } } : { result }),
    });
  }
  async notify(method: string, parameters: Json) {
    await this.send({ jsonrpc: "2.0", method, params: parameters });
  }
  read(cursor = 0) {
    const messages = [];
    let size = 0;
    for (const event of this.events.filter((e) => e.cursor > cursor)) {
      size += new TextEncoder().encode(JSON.stringify(event)).length;
      if (size > 56000) break;
      messages.push(event);
      if (messages.length === 10) break;
    }
    return {
      messages,
      cursor: messages.at(-1)?.cursor ?? cursor,
      dropped: !!this.events.length && cursor < this.events[0].cursor - 1,
      closed: this.#closed,
      exitCode: this.exitCode,
      stderr: this.stderr.text.slice(-1024),
    };
  }
  async #read() {
    let bytes = new Uint8Array(0);
    for (;;) {
      const { value: chunk, done } = await this.#stdout.read();
      if (done) break;
      if (bytes.length + chunk.length > 256 * 1024) {
        throw new Error("Protocol buffer exceeds limit");
      }
      const next = new Uint8Array(bytes.length + chunk.length);
      next.set(bytes);
      next.set(chunk, bytes.length);
      bytes = next;
      for (;;) {
        let end = -1;
        for (let i = 0; i + 3 < bytes.length; i++) {
          if (
            bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 &&
            bytes[i + 3] === 10
          ) {
            end = i;
            break;
          }
        }
        if (end < 0) {
          if (bytes.length > 8192) {
            throw new Error("Protocol header exceeds limit");
          }
          break;
        }
        if (end > 8192) throw new Error("Protocol header exceeds limit");
        const header = new TextDecoder().decode(bytes.subarray(0, end));
        const lengths = [...header.matchAll(/^Content-Length:\s*(\d+)\s*$/gmi)];
        if (lengths.length !== 1) throw new Error("Invalid protocol length");
        const length = Number(lengths[0][1]);
        if (length > 54000) throw new Error("Protocol message exceeds limit");
        if (bytes.length < end + 4 + length) break;
        const message = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(end + 4, end + 4 + length),
          ),
        );
        bytes = bytes.slice(end + 4 + length);
        const responseId = this.profile.kind === "debug"
          ? message.type === "response" ? message.request_seq : undefined
          : message.method === undefined
          ? message.id
          : undefined;
        if (responseId !== undefined) {
          const done = this.#pending.get(responseId);
          this.#pending.delete(responseId);
          if (message.error || message.success === false) {
            done?.reject(
              new Error(JSON.stringify(message.error ?? message.message)),
            );
          } else done?.resolve(message.result ?? message.body ?? null);
          continue;
        }
        const requestId = this.profile.kind === "debug"
          ? message.type === "request" ? message.seq : undefined
          : message.id;
        if (requestId !== undefined) {
          if (this.#incoming.size >= 32) {
            throw new Error("Too many unanswered server requests");
          }
          this.#incoming.set(
            requestId,
            message.command ?? message.method ?? "",
          );
        }
        this.events.push({ cursor: ++this.#cursor, message });
        if (this.events.length > 64) this.events.shift();
        this.hub.emit(`${this.profile.kind}.message`, {
          session: this.id,
          cursor: this.#cursor,
        }, this.owner);
      }
    }
    if (bytes.length) throw new Error("Truncated protocol message");
  }
  async close() {
    this.#fail(new Error("Protocol session closed"));
    void this.#writer.abort().catch(() => {});
    await Promise.allSettled([this.#stdout.cancel(), this.#stderr.cancel()]);
    await Promise.allSettled([
      this.#status,
      this.#reader,
      this.#errors,
    ]);
    this.releaseReservation();
  }
}
