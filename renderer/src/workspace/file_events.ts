import { createEffect, on, onCleanup } from "solid-js";
import { createAppAPI } from "../../../modules-sdk/js/app.ts";
import type { Json } from "../../../modules-sdk/js/mod.ts";

/** Subscribe before refreshing the tree; no timer-based directory polling. */
export function observeWorkspaceFiles(options: {
  identity(): string | null;
  request(method: string, p?: Json): Promise<Json>;
  changed(): Promise<void>;
  notify(message: string): void;
}) {
  const api = createAppAPI(options.request);
  createEffect(on(options.identity, (identity) => {
    if (!identity) return;
    let active = true, subscription: string | undefined;
    async function unsubscribe(id: string) {
      if (options.identity() !== identity) return;
      try {
        await api.events.unsubscribe({ subscription: id });
      } catch (error) {
        if (options.identity() === identity) {
          options.notify(`File watcher cleanup failed: ${String(error)}`);
        }
      }
    }
    onCleanup(() => {
      active = false;
      if (subscription) void unsubscribe(subscription);
    });
    void (async () => {
      const result = await api.events.subscribe({ topics: ["files.changed"] });
      if (!active) {
        await unsubscribe(result.subscription);
        return;
      }
      subscription = result.subscription;
      await options.changed();
      while (active) {
        const page = await api.events.next({ subscription, waitMs: 15000 });
        if (active && (page.events.length || page.dropped)) await options.changed();
      }
    })().catch((error) => {
      if (active) options.notify(`File change notifications unavailable: ${String(error)}`);
    });
  }));
}
