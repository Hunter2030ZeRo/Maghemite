import type { Json } from "../../../modules-sdk/js/mod.ts";
import { decodeSession } from "./model.ts";
type Request = (method: string, parameters?: Json) => Promise<Json>;
/** Browser cache keeps the last few keystrokes offline; host snapshots survive port/browser changes. */
export function createRecovery(notify: (text: string) => void) {
  let generation = 0, ready = false, revision: string | null = null;
  let pending: string | undefined, uploaded: string | undefined;
  let flight: Promise<void> | undefined;
  let key = "", request: Request | undefined;
  const metadata = () => `${key}.recovery`;
  function cache(text: string) {
    try {
      localStorage.setItem(
        metadata(),
        JSON.stringify({ revision, pending: text !== uploaded }),
      );
    } catch { /* normal snapshot reports storage failures */ }
  }
  function flush(): Promise<void> {
    if (flight) return flight;
    if (!ready || !pending || !request) return Promise.resolve();
    flight = upload().finally(() => {
      flight = undefined;
      if (ready && pending) void flush();
    });
    return flight;
  }
  async function upload() {
    const own = generation, send = request!, text = pending!;
    pending = undefined;
    try {
      const { transfer } = await send("recovery.begin", { revision }) as {
        transfer: string;
      };
      for (let offset = 0; offset < text.length; offset += 4096) {
        if (own !== generation) return;
        await send("recovery.chunk", {
          transfer,
          offset,
          text: text.slice(offset, offset + 4096),
        });
      }
      const result = await send("recovery.commit", { transfer }) as {
        revision: string;
      };
      if (own !== generation) return;
      revision = result.revision;
      uploaded = text;
      cache(pending ?? text);
    } catch (error) {
      if (own === generation) {
        ready = false;
        notify(
          `Host recovery unavailable; browser draft retained. ${String(error)}`,
        );
      }
    }
  }
  return {
    async checkpoint() {
      const own = generation;
      await flush();
      while (flight) await flight;
      if (own !== generation || !ready || pending) {
        throw new Error(
          "Could not preserve drafts on this computer. Reconnect before changing folders.",
        );
      }
    },
    disconnect() {
      generation++;
      ready = false;
      request = undefined;
      pending = undefined;
    },
    save(text: string) {
      if (!key) return;
      cache(text);
      if (text !== uploaded || flight) {
        pending = text;
        void flush();
      }
    },
    async connect(
      sessionKey: string,
      send: Request,
    ): Promise<string | undefined> {
      const own = ++generation;
      ready = false;
      pending = undefined;
      key = sessionKey;
      request = send;
      let local: string | null = null;
      try {
        local = localStorage.getItem(key);
      } catch {
        /* Host recovery also works when browser storage is disabled. */
      }
      let meta: { revision?: string | null; pending?: boolean } = {};
      try {
        meta = JSON.parse(localStorage.getItem(metadata()) ?? "{}");
      } catch { /* legacy browser snapshot */ }
      const start = await send("recovery.open") as {
        revision: string | null;
        transfer: string | null;
      };
      let text = "", offset = 0;
      if (start.transfer) {
        for (;;) {
          const page = await send("recovery.read", {
            transfer: start.transfer,
            offset,
          }) as { text: string; nextOffset: number | null };
          text += page.text;
          if (text.length > 3_000_000) {
            throw new Error("Recovery snapshot too large");
          }
          if (page.nextOffset === null) break;
          offset = page.nextOffset;
        }
      }
      if (own !== generation) return;
      if (start.transfer && !decodeSession(text)) {
        throw new Error("Invalid host recovery snapshot");
      }
      revision = start.revision;
      uploaded = text || undefined;
      let restore = text || local || undefined;
      if (
        local && decodeSession(local) && local !== text &&
        (meta.pending || !start.transfer)
      ) {
        if (
          (meta.revision ?? null) === start.revision || !start.transfer ||
          window.confirm(
            "A different recovery snapshot exists on this computer. Restore this browser's unsaved draft? Cancel restores the host snapshot. Both copies will be retained.",
          )
        ) {
          restore = local;
          if (text) localStorage.setItem(`${key}.previous-host`, text);
        } else localStorage.setItem(`${key}.previous-browser`, local);
      }
      ready = true;
      return restore;
    },
  };
}
