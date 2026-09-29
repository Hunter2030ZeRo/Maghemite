import type { Json } from "../../../modules-sdk/js/mod.ts";
import type { ApplicationCaller } from "../../modules/host/application.ts";
import { jsonCopy } from "../../modules/runtimes/protocol.ts";

export const EVENT_PERMISSIONS: Record<string, string> = {
  "files.changed": "files.read",
  "index.changed": "index.read",
  "settings.changed": "settings.read",
  "storage.changed": "storage.read",
  "documents.changed": "documents.read",
  "editor.selection": "editor.read",
  "diagnostics.changed": "diagnostics.read",
  "workspace.changed": "workspace.read",
  "terminal.output": "terminal.use",
  "tools.output": "tools.run",
  "language.message": "language.use",
  "debug.message": "debug.use",
  "views.action": "views.write",
};
type Event = { sequence: number; topic: string; data: Json };
type Subscription = {
  owner: string;
  topics: string[];
  queue: Event[];
  dropped: number;
  wake?: () => void;
  closed: boolean;
  waiting: boolean;
};
export class EventHub {
  #next = 0;
  #subscriptions = new Map<string, Subscription>();
  subscribe(
    topics: string[],
    caller: ApplicationCaller,
  ): { subscription: string } {
    for (const topic of topics) {
      if (
        !Object.hasOwn(EVENT_PERMISSIONS, topic) ||
        !caller.grants?.has(EVENT_PERMISSIONS[topic])
      ) throw new Error(`Event permission denied: ${topic}`);
    }
    const owner = caller.owner ?? caller.moduleId;
    if (
      !topics.length || this.#subscriptions.size >= 128 ||
      [...this.#subscriptions.values()].filter((s) => s.owner === owner)
          .length >= 8
    ) throw new Error("Subscription limit reached");
    const subscription = crypto.randomUUID();
    this.#subscriptions.set(subscription, {
      owner,
      topics: [...new Set(topics)],
      queue: [],
      dropped: 0,
      closed: false,
      waiting: false,
    });
    return { subscription };
  }
  emit(topic: string, data: Json, owner?: string) {
    if (new TextEncoder().encode(JSON.stringify(data)).length > 8192) {
      throw new Error("Event payload exceeds limit");
    }
    const event = { sequence: ++this.#next, topic, data: jsonCopy(data) };
    for (const sub of this.#subscriptions.values()) {
      if (!sub.topics.includes(topic) || (owner && sub.owner !== owner)) {
        continue;
      }
      if (sub.queue.length === 64) {
        sub.queue.shift();
        sub.dropped++;
      }
      sub.queue.push(event);
      sub.wake?.();
    }
  }
  #get(id: string, owner: string) {
    const sub = this.#subscriptions.get(id);
    if (!sub || sub.owner !== owner) {
      throw new Error("Unknown owned subscription");
    }
    return sub;
  }
  async next(id: string, waitMs: number, caller: ApplicationCaller) {
    const sub = this.#get(id, caller.owner ?? caller.moduleId);
    caller.signal.throwIfAborted();
    if (sub.waiting) throw new Error("Subscription already has a reader");
    sub.waiting = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: () => void = () => {};
    try {
      if (!sub.queue.length && waitMs) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          sub.wake = resolve;
          caller.signal.addEventListener("abort", wake, { once: true });
          timer = setTimeout(resolve, waitMs);
        });
      }
      caller.signal.throwIfAborted();
      if (sub.closed) throw new Error("Subscription closed");
      let bytes = 0, count = 0;
      for (const event of sub.queue) {
        bytes += new TextEncoder().encode(JSON.stringify(event)).length;
        if (bytes > 56000 || count === 20) break;
        count++;
      }
      const result = {
        events: sub.queue.splice(0, count),
        dropped: sub.dropped,
      };
      sub.dropped = 0;
      return result;
    } finally {
      clearTimeout(timer);
      caller.signal.removeEventListener("abort", wake);
      sub.wake = undefined;
      sub.waiting = false;
    }
  }
  unsubscribe(id: string, owner: string) {
    const sub = this.#get(id, owner);
    sub.closed = true;
    sub.wake?.();
    this.#subscriptions.delete(id);
  }
  release(owner: string) {
    for (const [id, sub] of this.#subscriptions) {
      if (sub.owner === owner) this.unsubscribe(id, owner);
    }
  }
}
