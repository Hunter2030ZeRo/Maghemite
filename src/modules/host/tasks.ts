/** Host-owned resources. Guests cannot choose processes, paths or permissions. */
export function delay(
  milliseconds: unknown,
  signal: AbortSignal,
): Promise<void> {
  if (
    typeof milliseconds !== "number" || !Number.isInteger(milliseconds) ||
    milliseconds < 0 || milliseconds > 300_000
  ) {
    return Promise.reject(
      new RangeError("Delay must be an integer from 0 to 300000 ms"),
    );
  }
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Task cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** A bounded pool of execution slots. Each job owns a fresh guest instance. */
export class WorkerPool {
  #active = 0;
  #queue: { start(): void }[] = [];
  #jobs = new Set<Promise<unknown>>();
  #stop = new AbortController();
  constructor(readonly concurrency = 4, readonly queueLimit = 32) {
    if (
      !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8 ||
      !Number.isInteger(queueLimit) || queueLimit < 0 || queueLimit > 128
    ) {
      throw new RangeError(
        "Workers require concurrency 1..8 and queue limit 0..128",
      );
    }
  }
  run<T>(
    work: (signal: AbortSignal) => Promise<T>,
    parent: AbortSignal,
  ): Promise<T> {
    const signal = AbortSignal.any([parent, this.#stop.signal]);
    const job = (async () => {
      await this.#acquire(signal);
      try {
        signal.throwIfAborted();
        return await work(signal);
      } finally {
        this.#active--;
        this.#queue.shift()?.start();
      }
    })();
    this.#jobs.add(job);
    void job.then(() => this.#jobs.delete(job), () => this.#jobs.delete(job));
    return job;
  }
  #acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#active < this.concurrency) {
      this.#active++;
      return Promise.resolve();
    }
    if (this.#queue.length >= this.queueLimit) {
      return Promise.reject(new Error("Worker queue is full"));
    }
    return new Promise((resolve, reject) => {
      const item = {
        start: () => {
          signal.removeEventListener("abort", abort);
          this.#active++;
          resolve();
        },
      };
      const abort = () => {
        const index = this.#queue.indexOf(item);
        if (index >= 0) this.#queue.splice(index, 1);
        signal.removeEventListener("abort", abort);
        reject(new DOMException("Worker cancelled while queued", "AbortError"));
      };
      this.#queue.push(item);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  async close() {
    this.#stop.abort();
    await Promise.allSettled([...this.#jobs]);
  }
}
