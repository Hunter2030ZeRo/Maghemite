import type { InstallationTestOptions } from "../../module_manager.ts";
import type { InstallationSnapshot } from "../../../shared/module_installations.ts";
import { gate } from "../aot-installation-support.ts";
import { barrier } from "../../../modules/host/fixtures/aot-preparation-support.ts";

const names = ["queued", "preparing", "committing", "response"] as const;
type Name = typeof names[number];
export type Trace = { sequence: number; event: string; data: unknown };

/** Only the owned fixture control server can arm these existing trusted hooks. */
export class InstallationBarriers extends EventTarget {
  readonly trace: Trace[] = [];
  readonly #gates = new Map<Name, ReturnType<typeof gate>>();
  #preparing = barrier("compiling");
  #failAfterExposure = false;
  record(event: string, data: unknown = null) {
    const entry = { sequence: this.trace.length + 1, event, data };
    this.trace.push(entry);
    console.log(`AOT_QA ${JSON.stringify(entry)}`);
    this.dispatchEvent(new Event("trace"));
  }
  arm(selected: unknown, failAfterExposure = false) {
    if (!Array.isArray(selected) ||
      !selected.every((name) => names.some((valid) => valid === name))) {
      throw new Error(`barriers must be an array of ${names.join(", ")}`);
    }
    this.releaseAll();
    this.#gates.clear();
    this.#preparing = barrier("compiling");
    for (const name of names) {
      if (selected.includes(name)) this.#gates.set(name, gate());
    }
    this.#failAfterExposure = failAfterExposure;
    this.record("armed", { barriers: selected, failAfterExposure });
  }
  release(name: string) {
    if (!names.some((valid) => valid === name)) throw new Error("Unknown barrier");
    if (name === "preparing") this.#preparing.release();
    for (const [key, held] of this.#gates) if (key === name) held.release();
    this.record("released", name);
  }
  releaseAll() {
    this.#preparing.release();
    for (const held of this.#gates.values()) held.release();
  }
  #hold(name: Name, operation: InstallationSnapshot) {
    const held = this.#gates.get(name);
    if (!held) return;
    this.record(`held:${name}`, operation);
    return held.hold();
  }
  readonly options: InstallationTestOptions = {
    boundary: (at, operation) => {
      if (at === "queued") return this.#hold("queued", operation);
      if (at === "before-rename") return this.#hold("committing", operation);
    },
    preparation: (event, operation) => {
      this.record(`native:${event.phase}`, { event, operation });
      if (event.phase === "compiling" && this.#gates.has("preparing")) {
        this.record("held:preparing", operation);
        return this.#preparing.observe(event);
      }
    },
    beforeResponse: (operation) => this.#hold("response", operation),
    afterCommit: (operation) => this.record("committed", operation),
    afterExposure: (operation) => {
      this.record("exposed", operation);
      if (this.#failAfterExposure) throw new Error("Fixture postcommit response recovery");
    },
  };
  async events(after: number, signal: AbortSignal) {
    signal.throwIfAborted();
    const pending = Promise.withResolvers<void>();
    const check = () => {
      if (this.trace.length > after) pending.resolve();
    };
    const abort = () => pending.reject(signal.reason);
    this.addEventListener("trace", check);
    signal.addEventListener("abort", abort, { once: true });
    check();
    try {
      await pending.promise;
      return this.trace.filter((event) => event.sequence > after);
    } finally {
      this.removeEventListener("trace", check);
      signal.removeEventListener("abort", abort);
    }
  }
}
