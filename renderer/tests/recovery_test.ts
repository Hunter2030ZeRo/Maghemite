import { rejects, strictEqual as eq } from "node:assert/strict";
import type { Json } from "../../modules-sdk/js/mod.ts";
import { createRecovery } from "../src/workspace/recovery.ts";

Deno.test("folder checkpoint waits for the newest draft even when an edit reverts during upload", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const cache = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => cache.get(key) ?? null,
      setItem: (key: string, text: string) => cache.set(key, text),
    },
  });
  try {
    let host = "", incoming = "", revision = 0, failing = false;
    let gate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
    const started = Promise.withResolvers<void>();
    const recovery = createRecovery(() => {});
    await recovery.connect(
      "qa.workspace",
      async (method, parameters): Promise<Json> => {
        if (failing) throw new Error("Recovery unavailable");
        if (method === "recovery.open") {
          return { revision: null, transfer: null };
        }
        if (method === "recovery.begin") {
          incoming = "";
          return { transfer: "upload" };
        }
        if (method === "recovery.chunk") {
          incoming += (parameters as { text: string }).text;
          return null;
        }
        if (method === "recovery.commit") {
          if (gate) {
            const pending = gate;
            gate = undefined;
            started.resolve();
            await pending.promise;
          }
          host = incoming;
          return { revision: String(++revision) };
        }
        throw new Error(`Unexpected ${method}`);
      },
    );
    recovery.save("original");
    await recovery.checkpoint();
    eq(host, "original");
    const pending = gate = Promise.withResolvers<void>();
    recovery.save("edited");
    await started.promise;
    recovery.save("original");
    const checkpoint = recovery.checkpoint();
    pending.resolve();
    await checkpoint;
    eq(host, "original");
    eq(revision, 3);
    failing = true;
    recovery.save("another draft");
    await rejects(() => recovery.checkpoint(), /preserve drafts/);
    eq(host, "original");
    recovery.disconnect();
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
