import { ok } from "node:assert/strict";
import { startDesktop } from "../../main.ts";
import type { InstallationTestOptions } from "../../module_manager.ts";
import type { InstallationState } from "../../../shared/module_installations.ts";
import { connectModules, type ModuleCommand } from "../../../../renderer/src/workspace/modules.ts";
import { bounded, writePackage } from "../aot-installation-support.ts";
import type { InstallationClock } from "./clock.ts";
import { interrupted } from "../../../modules/runtimes/preparation-process.ts";

export async function transportFixture(
  options: InstallationTestOptions = {},
  clock?: InstallationClock,
  existing?: { root: string; desktop: Awaited<ReturnType<typeof startDesktop>> },
) {
  const root = existing?.root ??
    await Deno.makeTempDir({ prefix: "maghemite-installation-transport-" });
  let desktop: Awaited<ReturnType<typeof startDesktop>> | undefined;
  let client: ReturnType<typeof connectModules> | undefined;
  const keys = ["fetch", "WebSocket", "location"] as const;
  const originals = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const nativeFetch = fetch, NativeSocket = WebSocket;
  const events = new EventTarget();
  let state: InstallationState = { activeOperation: null, outcomes: [], maintenance: [] };
  let catalog: ModuleCommand[] = [];
  const exposures: string[] = [];
  const frameBytes: number[] = [];
  try {
    if (existing) desktop = existing.desktop;
    else {
      await Deno.mkdir(`${root}/workspace`);
      await writePackage(`${root}/source`, 1, "tools");
      desktop = await startDesktop([
        "--port=0", `--data-dir=${root}/profile`, `--workspace=${root}/workspace`,
      ], { installation: options });
    }
    const app = desktop;
    Object.defineProperty(globalThis, "location", {
      configurable: true, value: new URL(app.url),
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: (input: string | URL | Request, init?: RequestInit) =>
        nativeFetch(input instanceof Request ? input : new URL(input, app.url), init),
    });
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: class {
        static OPEN = NativeSocket.OPEN;
        constructor(url: string | URL, protocols?: string | string[]) {
          // Deno supports WebSocketOptions headers; imported browser DOM types
          // expose only the standard protocols overload.
          const socket = Reflect.construct(NativeSocket, [
            url, { protocols, headers: { Origin: app.url } },
          ]);
          if (!(socket instanceof NativeSocket)) throw new Error("Invalid native socket");
          socket.addEventListener("message", (event) => {
            if (typeof event.data === "string") {
              frameBytes.push(new TextEncoder().encode(event.data).length);
            }
          });
          return socket;
        }
      },
    });
    const connect = async () => {
      const ready = Promise.withResolvers<void>();
      const received = Promise.withResolvers<void>();
      client = connectModules({
        invoke: () => null,
        catalog: (next) => { catalog = next; },
        installations: (next) => {
          state = next;
          events.dispatchEvent(new Event("state"));
          received.resolve();
        },
        exposed: (id) => { exposures.push(id); },
        status: (connected) => { if (connected) ready.resolve(); },
        notify: (message) => ready.reject(new Error(message)),
        scheduleTimeout: clock?.schedule,
      });
      await bounded(ready.promise);
      await bounded(received.promise);
      return client;
    };
    const initial = await connect();
    return {
      root, desktop: app, source: `${root}/source`, client: initial,
      exposures, frameBytes, catalog: () => catalog, state: () => state,
      wait(predicate: (value: InstallationState) => boolean, milliseconds = 30_000) {
        const done = Promise.withResolvers<InstallationState>();
        const check = () => { if (predicate(state)) done.resolve(state); };
        events.addEventListener("state", check);
        check();
        return interrupted(done.promise, AbortSignal.timeout(milliseconds))
          .finally(() => events.removeEventListener("state", check));
      },
      async reconnect() {
        app.application.disconnectWorkbench();
        client?.close();
        await app.application.settle();
        return await connect();
      },
      async install(directory = `${root}/source`, grants = ["wasm.execute"]) {
        const review = await client?.request("modules.prepare", { directory });
        ok(review && typeof review === "object" && !Array.isArray(review) && typeof review.token === "string");
        const parameters = { token: review.token, grants, operationId: crypto.randomUUID() };
        ok(client);
        return { parameters, accepted: client.request("modules.install", parameters) };
      },
      async [Symbol.asyncDispose]() {
        client?.close();
        if (!existing) await app.stop();
        for (const [index, key] of keys.entries()) {
          const original = originals[index];
          if (original) Object.defineProperty(globalThis, key, original);
          else Reflect.deleteProperty(globalThis, key);
        }
        if (!existing) await Deno.remove(root, { recursive: true });
      },
    };
  } catch (error) {
    client?.close();
    if (!existing) await desktop?.stop();
    for (const [index, key] of keys.entries()) {
      const original = originals[index];
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
    if (!existing) await Deno.remove(root, { recursive: true });
    throw error;
  }
}
