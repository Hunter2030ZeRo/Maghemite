import { instantiate, Pty } from "jsr:@sigma/pty-ffi@0.42.0/noinit";
import {
  Journal,
  OwnedProcess,
  type ProcessReservation,
  type ToolProfile,
} from "./processes.ts";
import { EventHub } from "./events.ts";
let initialized: Promise<void> | undefined;
export async function initializePty(library?: string) {
  await (initialized ??= instantiate(library).catch((e) => {
    initialized = undefined;
    throw e;
  }));
}
export class TerminalSession extends OwnedProcess {
  readonly output = new Journal(256 * 1024);
  readonly pty: Pty;
  #timer: ReturnType<typeof setInterval>;
  #closed = false;
  #decoder = new TextDecoder();
  #completion = Promise.withResolvers<void>();
  readonly finished = this.#completion.promise;
  done = false;
  exitCode: number | null = null;
  constructor(
    owner: string,
    profile: ToolProfile,
    cwd: string,
    columns: number,
    rows: number,
    hub: EventHub,
    reservation?: ProcessReservation,
  ) {
    super(owner, profile, reservation);
    this.pty = new Pty(profile.command, {
      args: profile.args ?? [],
      cwd,
      env: profile.env,
      size: { rows, cols: columns },
    });
    this.#timer = setInterval(() => {
      try {
        for (let i = 0; i < 16; i++) {
          const { data, done } = this.pty.readBytes();
          if (data.length) {
            this.output.append(this.#decoder.decode(data, { stream: true }));
            hub.emit("terminal.output", { session: this.id }, owner);
          }
          if (done) {
            this.output.append(this.#decoder.decode());
            this.done = true;
            this.exitCode = this.pty.exitCode ?? null;
            clearInterval(this.#timer);
            this.pty.close();
            this.#closed = true;
            this.releaseReservation();
            this.#completion.resolve();
            hub.emit("terminal.output", { session: this.id }, owner);
            break;
          }
          if (!data.length) break;
        }
      } catch (error) {
        this.output.append(String(error));
        void this.close();
      }
    }, 20);
  }
  read(cursor?: number) {
    const page = this.output.read(cursor);
    return {
      ...page,
      pending: page.cursor < this.output.base + this.output.text.length,
      done: this.done,
      exitCode: this.exitCode,
    };
  }
  write(text: string) {
    if (this.#closed || this.done) throw new Error("Terminal closed");
    this.pty.write(text);
  }
  resize(columns: number, rows: number) {
    if (this.#closed) throw new Error("Terminal closed");
    this.pty.resize({ cols: columns, rows });
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    this.pty.close();
    this.done = true;
    this.releaseReservation();
    this.#completion.resolve();
  }
}
