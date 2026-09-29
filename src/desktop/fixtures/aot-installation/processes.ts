import { deepStrictEqual as eq } from "node:assert/strict";
import { bounded } from "../aot-installation-support.ts";

/** Observe successful production Command.spawn calls, never progress/log markers. */
export function observeNativeProcesses(executable: string) {
  const Original = Deno.Command;
  const starts: { mode: string; args: string[]; pid: number; exited: boolean }[] = [];
  const pending = new Set<Promise<void>>();
  class ObservedCommand extends Original {
    readonly #native: boolean;
    readonly #args: string[];
    constructor(command: string | URL, options: Deno.CommandOptions = {}) {
      super(command, options);
      this.#native = String(command) === executable;
      this.#args = [...options.args ?? []];
    }
    override spawn() {
      const child = super.spawn();
      if (this.#native) {
        const start = { mode: this.#args[0], args: this.#args, pid: child.pid, exited: false };
        starts.push(start);
        const done = child.status.then(() => {
          start.exited = true;
          pending.delete(done);
        });
        pending.add(done);
      }
      return child;
    }
  }
  Deno.Command = ObservedCommand;
  return {
    starts,
    snapshot() {
      return {
        producers: starts.filter((item) => item.mode === "--aot-prepare").length,
        info: starts.filter((item) => item.mode === "--aot-info").length,
        components: starts.filter((item) => item.mode === "--component-aot").length,
        tools: starts.filter((item) => item.mode === "--wasi-tool-aot").length,
        live: starts.filter((item) => !item.exited).map((item) => item.pid),
      };
    },
    async close() {
      await bounded(Promise.all(pending));
      eq(Deno.Command, ObservedCommand);
      Deno.Command = Original;
      eq(starts.every((item) => item.exited), true);
    },
  };
}
