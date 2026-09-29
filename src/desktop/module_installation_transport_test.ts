import { deepStrictEqual as eq, ok, rejects, throws } from "node:assert/strict";
import { bounded, gate, snapshot, writePackage } from "./fixtures/aot-installation-support.ts";
import { startDesktop } from "./main.ts";
import { InstallationClock } from "./fixtures/aot-installation/clock.ts";
import { transportFixture } from "./fixtures/aot-installation/transport.ts";
import { createModuleRefresh } from "../../renderer/src/workspace/module_refresh.ts";
import { InstallationNotAcceptedError } from "../../renderer/src/workspace/modules.ts";
import type { InstallationState } from "../shared/module_installations.ts";
import { InstallationTransfers } from "./installation_transport.ts";

Deno.test("revision subscriptions outlive 60 seconds without occupying one long RPC", async () => {
  // Given real authenticated transport and held native preparation.
  const held = gate(), clock = new InstallationClock();
  await using f = await transportFixture({
    preparation: (event) => event.phase === "compiling" ? held.hold() : undefined,
    scheduleStatusTimeout: clock.schedule,
  }, clock);
  try {
    const install = await f.install();
    await install.accepted;
    await bounded(held.entered);
    let current = snapshot(await f.client.request("modules.installationStatus", {
      operationId: install.parameters.operationId,
    }));
    // When three exact 25-second subscription deadlines elapse.
    for (let index = 0; index < 3; index++) {
      const status = f.client.request("modules.installationStatus", {
        operationId: current.id, afterRevision: current.revision,
      });
      await clock.subscribers(1);
      clock.advance(25_000);
      current = snapshot(await bounded(status));
      eq(current.phase, "preparing");
    }
    // Then no 60-second RPC timed out and the original operation can commit.
    eq(clock.now, 75_000);
    const completed = f.wait((state) => state.outcomes.some((item) => item.id === current.id));
    held.release();
    const result = (await completed).outcomes.at(-1);
    eq([result?.phase, result?.committed, result?.completedTargets], ["succeeded", true, 2]);
    eq(f.exposures, ["test.preparation"]);
    eq(await f.client.execute("test.preparation.run"), 1);
  } finally { held.release(); }
});

Deno.test("server saturation reserves installation cancellation and per-request unmount cancellation", async () => {
  const held = gate(), clock = new InstallationClock();
  await using f = await transportFixture({
    preparation: (event) => event.phase === "compiling" ? held.hold() : undefined,
    scheduleStatusTimeout: clock.schedule,
  }, clock);
  try {
    const install = await f.install();
    await install.accepted;
    await bounded(held.entered);
    const current = snapshot(await f.client.request("modules.installationStatus", {
      operationId: install.parameters.operationId,
    }));
    const subscriptions = Array.from({ length: 8 }, () => new AbortController());
    const requests = subscriptions.map((owner) => f.client.request("modules.installationStatus", {
      operationId: current.id, afterRevision: current.revision,
    }, owner.signal));
    await clock.subscribers(8);
    await rejects(f.client.request("modules.list"), /queue is full/);
    // One unmounted request releases only its own subscription.
    const aborted = rejects(requests[0], /Abort/);
    subscriptions[0].abort();
    await aborted;
    await clock.subscribers(7);
    eq(f.state().activeOperation?.phase, "preparing");
    const replacement = f.client.request("modules.installationStatus", {
      operationId: current.id, afterRevision: current.revision,
    });
    await clock.subscribers(8);
    // All ordinary slots are full, but explicit app-job cancellation still reaches the manager.
    const terminal = f.wait((state) => state.outcomes.some((item) => item.id === current.id));
    await f.client.request("modules.cancelInstallation", { operationId: current.id });
    eq((await terminal).outcomes.at(-1)?.phase, "cancelled");
    await Promise.all([...requests.slice(1), replacement]);
    await clock.subscribers(0);
    eq(f.catalog(), []);
    eq(f.exposures, []);
  } finally { held.release(); }
});

Deno.test("disconnect aborts subscriptions but reconnect retains the preparing operation and one publication", async () => {
  const held = gate(), clock = new InstallationClock();
  await using f = await transportFixture({
    preparation: (event) => event.phase === "compiling" ? held.hold() : undefined,
    scheduleStatusTimeout: clock.schedule,
  }, clock);
  try {
    const install = await f.install();
    await install.accepted;
    await bounded(held.entered);
    const current = snapshot(await f.client.request("modules.installationStatus", {
      operationId: install.parameters.operationId,
    }));
    const waiting = f.client.request("modules.installationStatus", {
      operationId: current.id, afterRevision: current.revision,
    });
    const disconnected = rejects(waiting, /disconnected/);
    await clock.subscribers(1);
    const next = await f.reconnect();
    await disconnected;
    await clock.subscribers(0);
    await f.wait((state) => state.activeOperation?.id === current.id);
    eq(f.state().activeOperation?.id, current.id);
    eq(f.state().activeOperation?.phase, "preparing");
    eq(snapshot(await next.request("modules.install", install.parameters)).id, current.id);
    const completed = f.wait((state) => state.outcomes.some((item) => item.id === current.id));
    held.release();
    eq((await completed).outcomes.at(-1)?.committed, true);
    eq(f.exposures, ["test.preparation"]);
    eq(await next.execute("test.preparation.run"), 1);
  } finally { held.release(); }
});

Deno.test("commit before a lost acceptance response remains authoritative after reconnect and cancel", async () => {
  const response = gate();
  await using f = await transportFixture({
    beforeResponse: () => response.hold(),
    afterExposure: () => { throw new Error("fixture response recovery"); },
  });
  try {
    const install = await f.install();
    const lost = rejects(install.accepted, /disconnected/);
    await bounded(response.entered);
    const terminal = await f.wait((state) => state.outcomes.some((item) =>
      item.id === install.parameters.operationId && item.error !== null));
    const authoritative = terminal.outcomes.at(-1);
    ok(authoritative);
    eq([authoritative.phase, authoritative.committed], ["succeeded", true]);
    f.desktop.application.disconnectWorkbench();
    response.release();
    const next = await f.reconnect();
    await lost;
    const status = snapshot(await next.request("modules.installationStatus", {
      operationId: authoritative.id,
    }));
    eq(status, authoritative);
    eq(snapshot(await next.request("modules.cancelInstallation", {
      operationId: authoritative.id,
    })), authoritative);
    eq(snapshot(await next.request("modules.install", install.parameters)), authoritative);
    eq(f.exposures, ["test.preparation"]);
    eq(await next.execute("test.preparation.run"), 1);
  } finally { response.release(); }
});

Deno.test("exposure during a held older module list cannot lose the final refresh", async () => {
  const held = gate();
  await using f = await transportFixture();
  let items: string[] = [], loads = 0;
  const refresh = createModuleRefresh(async () => {
    const list = await f.client.request("modules.list");
    ok(list && typeof list === "object" && !Array.isArray(list) && Array.isArray(list.items));
    const ids = list.items.map((item) => {
      ok(item && typeof item === "object" && !Array.isArray(item) && typeof item.id === "string");
      return item.id;
    });
    if (++loads === 1) await held.hold();
    items = ids;
  });
  const old = refresh();
  await bounded(held.entered);
  const manager = f.desktop.application.moduleManager;
  ok(manager);
  const exposed = Promise.withResolvers<Promise<void>>();
  const changed = () => exposed.resolve(refresh());
  manager.addEventListener("exposed", changed, { once: true });
  try {
    const install = await f.install();
    await install.accepted;
    await bounded(manager.drain());
    held.release();
    await old;
    await exposed.promise;
    eq(items, ["test.preparation"]);
    eq(loads, 2);
  } finally {
    held.release();
    manager.removeEventListener("exposed", changed);
  }
});

Deno.test("real expired review rejection is definitively not accepted", async () => {
  await using f = await transportFixture();
  const review = await f.client.request("modules.prepare", { directory: f.source });
  ok(review && typeof review === "object" && !Array.isArray(review) && typeof review.token === "string");
  await f.client.request("modules.cancel", { token: review.token });
  await rejects(f.client.request("modules.install", {
    token: review.token, grants: ["wasm.execute"], operationId: crypto.randomUUID(),
  }), InstallationNotAcceptedError);
  eq(f.desktop.application.moduleManager?.installationState().activeOperation, null);
});

Deno.test("bootstrap serves the UI before automatic native maintenance and retains disabled grants", async () => {
  const root = await Deno.makeTempDir({ prefix: "maghemite-maintenance-ui-" });
  const held = gate(), slot = crypto.randomUUID();
  let desktop: Awaited<ReturnType<typeof startDesktop>> | undefined;
  try {
    const store = `${root}/profile/module-packages`;
    await writePackage(`${store}/packages/${slot}`, 1, "tools");
    await Deno.writeTextFile(`${store}/installed.json`, JSON.stringify([{
      id: "test.preparation", slot, grants: ["wasm.execute"], enabled: false,
    }]));
    desktop = await startDesktop(["--port=0", `--data-dir=${root}/profile`], {
      installation: { boundary: (at) => at === "queued" ? held.hold() : undefined },
    });
    await bounded(held.entered);
    const response = await fetch(desktop.url);
    eq(response.status, 200);
    ok((await response.text()).includes('<div id="root">'));
    eq(desktop.application.moduleManager?.installationState().activeOperation?.phase, "queued");
    const manager = desktop.application.moduleManager;
    ok(manager);
    held.release();
    await bounded(manager.drain());
    eq(manager.installationState().outcomes.at(-1)?.phase, "succeeded");
    eq(desktop.modules.commands(), []);
    const registry = JSON.parse(await Deno.readTextFile(`${store}/installed.json`));
    eq(registry.records[0].enabled, false);
    eq(registry.records[0].grants, ["wasm.execute"]);
  } finally {
    held.release();
    await desktop?.stop();
    await Deno.remove(root, { recursive: true });
  }
});

for (const route of ["list", "push"] as const) {
  Deno.test(`valid maximum installation state survives bounded ${route} transport`, async () => {
    await using f = await transportFixture();
    let client = f.client;
    const manager = f.desktop.application.moduleManager;
    ok(manager);
    // Exercise the real authenticated boundary with the maximum public DTO,
    // including worst-case three-byte error characters. No fake host is used.
    const maximum: InstallationState = {
      activeOperation: null,
      maintenance: Array.from({ length: 100 }, (_, index) => ({
        id: `test.module${index}`, error: "\uac00".repeat(1024),
      })),
      outcomes: Array.from({ length: 16 }, (_, index) => ({
        id: crypto.randomUUID(), moduleId: `test.module${index}`,
        kind: "maintenance", phase: "failed", completedTargets: 0,
        totalTargets: 2, revision: 3, committed: false,
        error: "\uac00".repeat(1024),
      })),
    };
    manager.installationState = () => structuredClone(maximum);
    if (route === "list") {
      const result = await f.client.request("modules.list");
      ok(result && typeof result === "object" && !Array.isArray(result));
      eq(result.maintenance, maximum.maintenance);
      eq(result.outcomes, maximum.outcomes);
    } else {
      manager.dispatchEvent(new Event("change"));
      await f.client.request("workspace.info");
      eq(await f.wait((state) => state.maintenance.length === 100), maximum);
      client = await f.reconnect();
      eq(await f.wait((state) => state.maintenance.length === 100), maximum);
    }
    await rejects(client.request("modules.cancelInstallation", {
      operationId: maximum.outcomes[0].id,
    }), /Unknown installation operation/);
    ok(f.frameBytes.length > 2);
    ok(f.frameBytes.every((bytes) => bytes < 65536));
  });
}

Deno.test("installation fragments retain bounded request ownership and reject out-of-order acknowledgements", () => {
  const sent: unknown[] = [];
  const transfers = new InstallationTransfers((message) => sent.push(message));
  const state = { type: "installations", value: "\uac00".repeat(100_000) };
  transfers.begin(0, state);
  eq(sent.length, 1);
  throws(() => transfers.next(0, 1, 1), /offset/);
  transfers.begin(0, { ...state, value: state.value + "new" });
  transfers.next(0, 1, 16384);
  eq(sent.length, 2); // The superseded state's late acknowledgement owns nothing.
  transfers.begin(42, state);
  transfers.cancel(42);
  transfers.next(42, 3, 16384);
  eq(sent.length, 3);
  transfers.clear();
  transfers.next(0, 2, 16384);
  eq(sent.length, 3);
  ok(sent.every((frame) => new TextEncoder().encode(JSON.stringify(frame)).length < 65536));
});
