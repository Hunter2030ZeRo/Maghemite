import { deepStrictEqual as eq, ok, rejects } from "node:assert/strict";
import { ModuleManager } from "./module_manager.ts";
import {
  bounded,
  gate,
  install,
  installationFixture,
  outcome,
  requestSignal,
  snapshot,
  writePackage,
} from "./fixtures/aot-installation-support.ts";
import { verifyInterruptedInstallation } from "./fixtures/aot-installation-recovery.ts";
import { verifyMaintenance } from "./fixtures/aot-installation-maintenance.ts";
import { RegistryFile } from "./module_installation_registry.ts";

for (const enabled of [true, false]) {
  Deno.test(`engine maintenance validates readiness and preserves enabled=${enabled}`, () =>
    verifyMaintenance("engine", enabled));
}

Deno.test("legacy maintenance terminally fences the reclaimed source slot", () =>
  verifyMaintenance("legacy", true));

Deno.test("failed maintenance leaves legacy records grants and disabled state intact", async () => {
  await using f = await installationFixture({}, "component");
  await f.manager.close();
  const reviewed = await f.coordinator.store.review(f.source);
  const record = {
    id: "example.rust",
    slot: reviewed.slot,
    enabled: false,
    grants: ["log", "tasks.progress"],
  };
  await Deno.writeTextFile(
    `${f.coordinator.store.directory}/installed.json`,
    JSON.stringify([record]),
  );
  const manager = new ModuleManager(f.host, f.coordinator, {
    preparation: () => {
      throw new Error("incompatible maintenance");
    },
  });
  try {
    await manager.restore();
    const [accepted] = await manager.maintain(record.id);
    const failed = await outcome(manager, accepted.id);
    eq([failed.phase, failed.committed], ["failed", false]);
    eq((await f.registry()).records, [record]);
    eq(f.host.commands(), []);
    ok(
      manager.installationState().maintenance[0].error.includes("incompatible"),
    );
  } finally {
    await manager.close();
  }
});

Deno.test("cutover invalidates queued starts before registry rename", async () => {
  const barrier = gate();
  let armed = false, sawDrain = false;
  await using f = await installationFixture({
    boundary: (at) => {
      if (!armed) return;
      if (at === "generation") return barrier.hold();
      if (at === "before-rename") {
        const state = f.resources.inspect();
        eq([state.processes.length, state.queued, state.reservedBytes], [
          0,
          0,
          0,
        ]);
        sawDrain = true;
      }
    },
  });
  const first = await install(f.manager, f.source);
  await outcome(f.manager, first.accepted.id);
  await writePackage(f.source, 2);
  armed = true;
  const second = await install(f.manager, f.source);
  await bounded(barrier.entered);
  const blocker = await f.resources.reserveHostUsage({
    id: "cutover-blocker",
    label: "test reservation",
    reservedBytes: f.resources.inspect().budgetBytes,
    rssBytes: null,
    diskBytes: null,
  }, requestSignal());
  const queued = gate();
  const observe = () => {
    if (f.resources.queued("test.preparation") === 1) void queued.hold();
  };
  f.resources.addEventListener("change", observe);
  const command = f.host.execute("test.preparation.run", null, {
    signal: requestSignal(),
  });
  const rejected = rejects(command, /abort|cancel|changed/i);
  try {
    await bounded(queued.entered);
    // Release only the guest-independent host reservation. The queued command
    // remains fenced by the synchronous cutover before an admitted spawn.
    const drained = Promise.withResolvers<void>();
    const onChange = () => {
      if (f.resources.queued("test.preparation") === 0) drained.resolve();
    };
    f.resources.addEventListener("change", onChange);
    barrier.release();
    await bounded(drained.promise);
    f.resources.removeEventListener("change", onChange);
    blocker.release();
    await rejected;
    eq((await outcome(f.manager, second.accepted.id)).phase, "succeeded");
    eq(sawDrain, true);
    eq(await f.host.execute("test.preparation.run"), 2);
  } finally {
    f.resources.removeEventListener("change", observe);
    blocker.release();
    barrier.release();
    queued.release();
  }
});

Deno.test("concurrent identical acceptance returns one durable identity", async () => {
  const barrier = gate();
  await using f = await installationFixture({
    boundary: (at) => at === "queued" ? barrier.hold() : undefined,
  });
  const review = await f.manager.request("modules.prepare", {
    directory: f.source,
  }, requestSignal());
  ok(
    review && typeof review === "object" && !Array.isArray(review) &&
      typeof review.token === "string",
  );
  const params = {
    token: review.token,
    grants: [],
    operationId: crypto.randomUUID(),
  };
  const a = f.manager.request("modules.install", params, requestSignal());
  const b = f.manager.request("modules.install", params, requestSignal());
  try {
    eq(snapshot(await a).id, snapshot(await b).id);
    eq((await f.registry()).activeOperation?.snapshot.id, params.operationId);
    barrier.release();
    eq((await outcome(f.manager, params.operationId)).phase, "succeeded");
    eq((await f.registry()).outcomes.length, 1);
  } finally {
    barrier.release();
  }
});

Deno.test(
  "process death fences native output and recovers durable interrupted identity",
  verifyInterruptedInstallation,
);

Deno.test("cutover drains an actual guest and workers before committing its replacement", async () => {
  let armed = false;
  await using f = await installationFixture({
    boundary: (at) => {
      if (armed && at === "before-rename") {
        eq([
          f.resources.inspect().processes.length,
          f.resources.inspect().queued,
        ], [0, 0]);
      }
    },
  });
  const manifest = JSON.parse(
    await Deno.readTextFile(`${f.source}/maghemite.module.json`),
  );
  manifest.capabilities = ["tasks.progress", "tasks.run-worker"];
  manifest.workers = ["test.preparation.worker"];
  manifest.contributions.commands.push({
    id: "test.preparation.worker",
    title: "Worker",
  });
  await Deno.writeTextFile(
    `${f.source}/maghemite.module.json`,
    JSON.stringify(manifest),
  );
  await Deno.writeTextFile(
    `${f.source}/main.ts`,
    `export default {commands:{
    "test.preparation.run": async (_,ctx)=>await Promise.all([1,2].map(n=>ctx.runWorker("test.preparation.worker",n))),
    "test.preparation.worker": async (_,ctx)=>{await ctx.reportProgress({message:"held",completed:0});return await new Promise(()=>{});}
  }};`,
  );
  const installed = await install(f.manager, f.source, [
    "tasks.progress",
    "tasks.run-worker",
  ]);
  await outcome(f.manager, installed.accepted.id);
  const started = Promise.withResolvers<void>();
  let workers = 0;
  const command = f.host.execute("test.preparation.run", null, {
    signal: requestSignal(),
    onProgress: () => {
      if (++workers === 2) started.resolve();
    },
  });
  const cancelled = rejects(command, /cancel|abort|closed/i);
  await bounded(started.promise);
  eq(f.resources.inspect().processes.length, 3);
  await writePackage(f.source, 2);
  armed = true;
  const replacement = await install(f.manager, f.source);
  eq((await outcome(f.manager, replacement.accepted.id)).phase, "succeeded");
  await cancelled;
  eq(await f.host.execute("test.preparation.run"), 2);
});

Deno.test("status timeout is an event subscription and close after commit cannot cancel success", async () => {
  const barrier = gate();
  let close: Promise<void> | undefined;
  let fire: (() => void) | undefined;
  let cleared = false;
  await using f = await installationFixture({
    boundary: (at) => at === "queued" ? barrier.hold() : undefined,
    afterCommit: () => {
      close = f.manager.close();
    },
    scheduleStatusTimeout: (expire, milliseconds) => {
      eq(milliseconds, 25_000);
      fire = expire;
      return () => {
        cleared = true;
      };
    },
  });
  const accepted = await install(f.manager, f.source);
  await bounded(barrier.entered);
  try {
    const current = snapshot(
      await f.manager.request("modules.installationStatus", {
        operationId: accepted.accepted.id,
      }, requestSignal()),
    );
    const subscribed = f.manager.request("modules.installationStatus", {
      operationId: current.id,
      afterRevision: current.revision,
    }, requestSignal());
    ok(fire);
    fire();
    eq(snapshot(await subscribed), current);
    eq(cleared, true);
  } finally {
    barrier.release();
  }
  await bounded(f.manager.drain());
  ok(close);
  await bounded(close);
  eq((await f.registry()).outcomes.at(-1)?.snapshot.committed, true);
  eq(await f.host.execute("test.preparation.run"), 1);
});

Deno.test("delayed response A cannot clear newer acceptance B or lose its duplicate waiter", async () => {
  const response = gate(), publication = gate();
  const firstId = crypto.randomUUID(), secondId = crypto.randomUUID();
  await using f = await installationFixture({
    beforeResponse: (accepted) =>
      accepted.id === firstId ? response.hold() : undefined,
  });
  const parameters = async (operationId: string) => {
    const review = await f.manager.request("modules.prepare", {
      directory: f.source,
    }, requestSignal());
    ok(
      review && typeof review === "object" && !Array.isArray(review) &&
        typeof review.token === "string",
    );
    return { token: review.token, grants: [], operationId };
  };
  const first = f.manager.request(
    "modules.install",
    await parameters(firstId),
    requestSignal(),
  );
  const original = RegistryFile.prototype.publish;
  try {
    await bounded(response.entered);
    await bounded(f.manager.drain());
    RegistryFile.prototype.publish = async function (
      ...args: Parameters<RegistryFile["publish"]>
    ) {
      if (
        args[0].activeOperation?.snapshot.id === secondId &&
        args[0].activeOperation.snapshot.phase === "queued"
      ) {
        await publication.hold();
      }
      await original.apply(this, args);
    };
    const input = await parameters(secondId);
    const second = f.manager.request("modules.install", input, requestSignal());
    await bounded(publication.entered);
    response.release();
    await first;
    // B has not renamed yet. Its identical retry must join B, not hit busy.
    const duplicate = f.manager.request(
      "modules.install",
      input,
      requestSignal(),
    );
    const results = Promise.allSettled([second, duplicate]);
    publication.release();
    const settled = await bounded(results);
    eq(settled.map((result) => result.status), ["fulfilled", "fulfilled"]);
    for (const result of settled) {
      ok(result.status === "fulfilled");
      eq(snapshot(result.value).id, secondId);
    }
    eq((await outcome(f.manager, secondId)).phase, "succeeded");
  } finally {
    response.release();
    publication.release();
    RegistryFile.prototype.publish = original;
  }
});

Deno.test("queued publication sync failure still drains accepted ownership", async () => {
  await using f = await installationFixture();
  const original = RegistryFile.prototype.publish;
  let closing: Promise<void> | undefined;
  RegistryFile.prototype.publish = async function (
    ...args: Parameters<RegistryFile["publish"]>
  ) {
    await original.apply(this, args);
    if (args[0].activeOperation?.snapshot.phase === "queued") {
      closing = f.manager.close();
      // Observe immediately; the assertion below still requires resolution.
      void closing.catch(() => {});
      throw new Error("injected sync failure after durable acceptance");
    }
  };
  try {
    await rejects(install(f.manager, f.source), /sync failure/);
    ok(closing);
    await bounded(closing);
    eq((await f.registry()).activeOperation, null);
    eq((await f.registry()).outcomes.at(-1)?.snapshot.phase, "cancelled");
    eq(
      await Array.fromAsync(
        Deno.readDir(`${f.coordinator.store.directory}/packages`),
      ),
      [],
    );
  } finally {
    RegistryFile.prototype.publish = original;
  }
});

Deno.test("terminal publication failure fences further acceptance until recovery", async () => {
  await using f = await installationFixture();
  await f.manager.close();
  const barrier = gate();
  const manager = new ModuleManager(f.host, f.coordinator, {
    boundary: (at) => at === "queued" ? barrier.hold() : undefined,
  });
  await manager.restore();
  const original = RegistryFile.prototype.publish;
  try {
    const accepted = await install(manager, f.source);
    await bounded(barrier.entered);
    RegistryFile.prototype.publish = async function (
      ...args: Parameters<RegistryFile["publish"]>
    ) {
      if (args[0].outcomes.at(-1)?.snapshot.phase === "cancelled") {
        throw new Error("terminal disk failure");
      }
      await original.apply(this, args);
    };
    await manager.request("modules.cancelInstallation", {
      operationId: accepted.accepted.id,
    }, requestSignal());
    await rejects(manager.drain(), /terminal disk failure/);
    await rejects(
      manager.request(
        "modules.prepare",
        { directory: f.source },
        requestSignal(),
      ),
      /in progress/,
    );
    eq((await f.registry()).activeOperation?.snapshot.id, accepted.accepted.id);
  } finally {
    barrier.release();
    RegistryFile.prototype.publish = original;
    await rejects(manager.close());
  }
});
