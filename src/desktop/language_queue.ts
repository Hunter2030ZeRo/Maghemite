import type { Json } from "../../modules-sdk/js/mod.ts";

type Task = {
  key: string;
  interactive: boolean;
  signal: AbortSignal;
  run(): Promise<Json>;
  resolve(value: Json): void;
  reject(reason: unknown): void;
  abort(): void;
};
/** Serialize document transactions while keeping obsolete pointer/typing work out of the guest. */
export class LanguageQueue {
  #tasks: Task[] = [];
  #running = false;
  #interactiveRuns = 0;
  enqueue(
    key: string,
    interactive: boolean,
    signal: AbortSignal,
    run: () => Promise<Json>,
  ): Promise<Json> {
    signal.throwIfAborted();
    // Only replace waiting interactive queries. An executing transaction must finish atomically.
    if (interactive) {
      for (const task of [...this.#tasks]) {
        if (task.key === key) this.#remove(task, null);
      }
    }
    if (this.#tasks.length >= 32) {
      return Promise.reject(new Error("Language queue full"));
    }
    return new Promise((resolve, reject) => {
      const task: Task = {
        key,
        interactive,
        signal,
        run,
        resolve,
        reject,
        abort: () => {
          this.#remove(task, null);
        },
      };
      signal.addEventListener("abort", task.abort, { once: true });
      this.#tasks.push(task);
      if (!this.#running) void this.#drain();
    });
  }
  clear() {
    for (const task of [...this.#tasks]) this.#remove(task, null);
  }
  #remove(task: Task, result: Json) {
    const index = this.#tasks.indexOf(task);
    if (index < 0) return;
    this.#tasks.splice(index, 1);
    task.signal.removeEventListener("abort", task.abort);
    task.resolve(result);
  }
  async #drain() {
    this.#running = true;
    try {
      while (this.#tasks.length) {
        // Eight interactive queries at most before allowing one waiting background page.
        const preferred = this.#tasks.findIndex((t) =>
          t.interactive === (this.#interactiveRuns < 8)
        );
        const [task] = this.#tasks.splice(preferred < 0 ? 0 : preferred, 1);
        task.signal.removeEventListener("abort", task.abort);
        this.#interactiveRuns = task.interactive
          ? this.#interactiveRuns + 1
          : 0;
        try {
          task.signal.throwIfAborted();
          task.resolve(await task.run());
        } catch (error) {
          task.reject(error);
        }
      }
    } finally {
      this.#running = false;
      this.#interactiveRuns = 0;
    }
  }
}
