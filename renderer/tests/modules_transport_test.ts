/// <reference lib="dom" />
import { deepStrictEqual as eq, ok, rejects } from "node:assert/strict";
import { connectModules } from "../src/workspace/modules.ts";

Deno.test("client queue saturation reserves cancellation and abort frames keep monotonic ownership", async () => {
  const keys = ["fetch", "WebSocket", "location"] as const;
  const originals = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const created = Promise.withResolvers<Socket>();
  const connected = Promise.withResolvers<void>();
  class Socket {
    static OPEN = 1;
    readyState = 1;
    readonly sent: { type: string; id: number; action?: string; requestId?: number }[] = [];
    onopen?: () => void;
    onclose?: () => void;
    onerror?: () => void;
    onmessage?: (event: { data: string }) => void;
    constructor() { created.resolve(this); }
    send(text: string) { this.sent.push(JSON.parse(text)); }
    close() { this.readyState = 3; }
    reply(id: number) {
      this.onmessage?.({ data: JSON.stringify({ type: "executed", id, ok: true, value: null }) });
    }
  }
  Object.defineProperty(globalThis, "fetch", {
    configurable: true, value: () => Promise.resolve(Response.json({ token: "owned" })),
  });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: Socket });
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("http://127.0.0.1:8000") });
  const client = connectModules({
    invoke: () => null, catalog() {}, notify() {},
    status: (ready) => { if (ready) connected.resolve(); },
  });
  try {
    const socket = await created.promise;
    socket.onopen?.();
    await connected.promise;
    const owners = Array.from({ length: 16 }, () => new AbortController());
    const waiting = owners.map((owner) => client.request("modules.installationStatus", {
      operationId: crypto.randomUUID(), afterRevision: 1,
    }, owner.signal));
    const settled = Promise.allSettled(waiting);
    await rejects(client.request("modules.list"), /queue full/);
    const cancel = client.request("modules.cancelInstallation", { operationId: crypto.randomUUID() });
    const cancelFrame = socket.sent.at(-1);
    ok(cancelFrame);
    eq(cancelFrame.action, "modules.cancelInstallation");
    owners[0].abort();
    const frame = socket.sent.at(-1);
    eq(frame?.type, "cancelRequest");
    eq(frame?.requestId, socket.sent[0].id);
    ok(frame && frame.id > cancelFrame.id);
    socket.reply(cancelFrame.id);
    await cancel;
    client.close();
    eq((await settled).map((result) => result.status), Array(16).fill("rejected"));
    eq(socket.sent.filter((item) => item.type === "cancelRequest").length, 1);
  } finally {
    client.close();
    for (const [index, key] of keys.entries()) {
      const original = originals[index];
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
