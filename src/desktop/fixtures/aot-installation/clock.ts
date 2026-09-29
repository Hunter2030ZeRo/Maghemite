import { bounded } from "../aot-installation-support.ts";

/** Manual deadlines for both renderer RPCs and manager revision subscriptions. */
export class InstallationClock extends EventTarget {
  now = 0;
  readonly #timers = new Set<{ at: number; milliseconds: number; expire(): void }>();
  readonly schedule = (expire: () => void, milliseconds: number) => {
    const timer = { at: this.now + milliseconds, milliseconds, expire };
    this.#timers.add(timer);
    this.dispatchEvent(new Event("change"));
    return () => {
      this.#timers.delete(timer);
      this.dispatchEvent(new Event("change"));
    };
  };
  count(milliseconds: number) {
    return [...this.#timers].filter((timer) => timer.milliseconds === milliseconds).length;
  }
  async subscribers(count: number) {
    const done = Promise.withResolvers<void>();
    const check = () => { if (this.count(25_000) === count) done.resolve(); };
    this.addEventListener("change", check);
    check();
    try { await bounded(done.promise); }
    finally { this.removeEventListener("change", check); }
  }
  advance(milliseconds: number) {
    this.now += milliseconds;
    for (const timer of [...this.#timers].sort((a, b) => a.at - b.at)) {
      if (timer.at <= this.now && this.#timers.delete(timer)) timer.expire();
    }
  }
}
