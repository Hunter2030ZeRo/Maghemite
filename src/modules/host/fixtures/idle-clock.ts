import { equal } from "node:assert/strict";

/** Control only the selected idle/deadline duration; I/O and bounded guards stay real. */
export class IdleClock {
  readonly #set = globalThis.setTimeout;
  readonly #clear = globalThis.clearTimeout;
  readonly #timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  readonly #replacement;
  readonly #clearReplacement;
  constructor(milliseconds: number) {
    this.#replacement = (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay !== milliseconds) return this.#set(callback, delay, ...args);
      const timer = this.#set(() => {
        throw new Error("Controlled idle timer was not advanced");
      }, 2_147_483_647);
      this.#timers.set(timer, () => {
        if (typeof callback !== "function") throw new Error("Expected timer callback");
        callback(...args);
      });
      return timer;
    };
    this.#clearReplacement = (timer?: ReturnType<typeof setTimeout>) => {
      if (timer !== undefined) this.#timers.delete(timer);
      this.#clear(timer);
    };
    Object.defineProperty(globalThis, "setTimeout", { configurable: true, writable: true, value: this.#replacement });
    Object.defineProperty(globalThis, "clearTimeout", { configurable: true, writable: true, value: this.#clearReplacement });
  }
  get pending() { return this.#timers.size; }
  advance() {
    for (const [timer, callback] of [...this.#timers]) {
      this.#timers.delete(timer);
      this.#clear(timer);
      callback();
    }
  }
  [Symbol.dispose]() {
    equal(globalThis.setTimeout, this.#replacement);
    equal(globalThis.clearTimeout, this.#clearReplacement);
    for (const timer of this.#timers.keys()) this.#clear(timer);
    this.#timers.clear();
    globalThis.setTimeout = this.#set;
    globalThis.clearTimeout = this.#clear;
  }
}
