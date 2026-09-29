import {
  deepStrictEqual as eq,
  notEqual,
  ok,
  rejects,
  throws,
} from "node:assert/strict";
import { ModuleManager } from "./module_manager.ts";
import { ModuleHost } from "../modules/host/host.ts";
import {
  bounded,
  gate,
  install,
  installationFixture,
  nativeExecutable,
  openCoordinator,
  outcome,
  requestSignal,
  snapshot,
  writePackage,
} from "./fixtures/aot-installation-support.ts";
import type { InstallationBoundary } from "./module_installation_transaction.ts";
import { parseRegistry } from "./module_installation_registry.ts";
import "./module_installation_recovery_test.ts";
import "./module_installation_legacy_test.ts";

Deno.test("installation durably accepts duplicate IDs and subscriptions without blocking old commands", async () => {
  const barrier = gate();
  let hold = false;
  await using f = await installationFixture({
    preparation: (event) =>
      hold && event.phase === "locked" ? barrier.hold() : undefined,
  }, "tools");
  const first = await install(f.manager, f.source, ["wasm.execute"]);
  eq((await outcome(f.manager, first.accepted.id)).phase, "succeeded");
  const old = (await f.registry()).records[0];
  await writePackage(f.source, 2, "tools");
  hold = true;
  const update = await install(f.manager, f.source, ["wasm.execute"]);
  await bounded(barrier.entered);
  try {
    eq(update.accepted.phase, "queued");
    eq((await f.registry()).activeOperation?.snapshot.id, update.accepted.id);
    eq(await f.host.execute("test.preparation.run"), 1);
    const duplicate = snapshot(
      await f.manager.request(
        "modules.install",
        update.parameters,
        requestSignal(),
      ),
    );
    eq(duplicate.id, update.accepted.id);
    await rejects(
      f.manager.request(
        "modules.install",
        { ...update.parameters, grants: [] },
        requestSignal(),
      ),
      /different inputs/,
    );
    const current = snapshot(
      await f.manager.request("modules.installationStatus", {
        operationId: update.accepted.id,
      }, requestSignal()),
    );
    const next = f.manager.request("modules.installationStatus", {
      operationId: current.id,
      afterRevision: current.revision,
    }, requestSignal());
    barrier.release();
    ok(snapshot(await bounded(next)).revision > current.revision);
    const completed = await outcome(f.manager, current.id);
    eq([
      completed.phase,
      completed.committed,
      completed.completedTargets,
      completed.totalTargets,
    ], ["succeeded", true, 2, 2]);
    const registry = await f.registry();
    notEqual(registry.records[0].slot, old.slot);
    ok(registry.records[0].artifactSetId);
    eq(registry.activeOperation, null);
    eq(await f.host.execute("test.preparation.run"), 2);
    eq(
      snapshot(
        await f.manager.request(
          "modules.install",
          update.parameters,
          requestSignal(),
        ),
      ),
      completed,
    );
  } finally {
    barrier.release();
  }
});

const boundaries: readonly InstallationBoundary[] = [
  "queued",
  "generation",
  "validated",
  "fenced",
  "before-rename",
];
for (const boundary of boundaries) {
  for (const cancel of [false, true]) {
    Deno.test(`${cancel ? "cancel" : "failure"} before ${boundary} preserves previous complete installation`, async () => {
      const barrier = gate();
      let armed = false;
      await using f = await installationFixture({
        boundary: (at) => {
          if (!armed || at !== boundary) return;
          if (cancel) return barrier.hold();
          throw new Error(`injected ${at}`);
        },
      });
      const first = await install(f.manager, f.source);
      eq((await outcome(f.manager, first.accepted.id)).phase, "succeeded");
      const before = (await f.registry()).records;
      await writePackage(f.source, 2);
      armed = true;
      const update = await install(f.manager, f.source);
      if (cancel) {
        await bounded(barrier.entered);
        await f.manager.request("modules.cancelInstallation", {
          operationId: update.accepted.id,
        }, requestSignal());
      }
      try {
        const result = await outcome(f.manager, update.accepted.id);
        eq([result.phase, result.committed], [
          cancel ? "cancelled" : "failed",
          false,
        ]);
        eq((await f.registry()).records, before);
        eq(await f.host.execute("test.preparation.run"), 1);
        eq(
          (await Array.fromAsync(
            Deno.readDir(`${f.coordinator.store.directory}/packages`),
          )).length,
          1,
        );
      } finally {
        barrier.release();
      }
    });
  }
}

for (const target of [0, 1, 2]) {
  for (const cancel of [true, false]) {
    Deno.test(`${cancel ? "cancellation" : "failure"} at native target boundary ${target} never publishes late output`, async () => {
      const barrier = gate();
      await using f = await installationFixture({
        preparation: (event) => {
          const reached = target === 2
            ? event.phase === "ready"
            : event.phase === "compiling" && event.completed === target;
          if (!reached) return;
          if (cancel) return barrier.hold();
          throw new Error("injected native object failure");
        },
      }, "tools");
      const accepted = await install(f.manager, f.source, ["wasm.execute"]);
      try {
        if (cancel) {
          await bounded(barrier.entered);
          await f.manager.request("modules.cancelInstallation", {
            operationId: accepted.accepted.id,
          }, requestSignal());
        }
        eq(
          (await outcome(f.manager, accepted.accepted.id)).phase,
          cancel ? "cancelled" : "failed",
        );
        eq(f.host.commands(), []);
        eq((await f.registry()).records, []);
        eq([
          f.resources.inspect().processes.length,
          f.resources.inspect().reservedBytes,
          f.resources.inspect().queued,
        ], [0, 0, 0]);
        eq(await f.coordinator.store.orphanStagingIds(), []);
      } finally {
        barrier.release();
      }
    });
  }
}

for (
  const failure of ["afterCommit", "afterExposure", "beforeResponse"] as const
) {
  Deno.test(`committed result survives ${failure} failure and noncompiling restoration`, async () => {
    let armed = false;
    await using f = await installationFixture({
      [failure]: () => {
        if (armed) throw new Error("response/exposure disconnected");
      },
    });
    const first = await install(f.manager, f.source);
    await outcome(f.manager, first.accepted.id);
    await writePackage(f.source, 2);
    const review = await f.manager.request("modules.prepare", {
      directory: f.source,
    }, requestSignal());
    ok(
      review && typeof review === "object" && !Array.isArray(review) &&
        typeof review.token === "string",
    );
    const operationId = crypto.randomUUID();
    armed = true;
    const acceptance = f.manager.request("modules.install", {
      token: review.token,
      grants: [],
      operationId,
    }, requestSignal());
    if (failure === "beforeResponse") await rejects(acceptance, /disconnected/);
    else await acceptance;
    const result = await outcome(f.manager, operationId);
    eq([result.phase, result.committed], ["succeeded", true]);
    if (failure !== "beforeResponse") ok(result.error?.includes("recovery"));
    eq(
      snapshot(
        await f.manager.request(
          "modules.cancelInstallation",
          { operationId },
          requestSignal(),
        ),
      ).committed,
      true,
    );
    eq((await f.registry()).outcomes.at(-1)?.snapshot.committed, true);
    await f.manager.close();
    await f.host.close();
    await f.coordinator.close();
    const host = new ModuleHost({
      resources: f.resources,
      wasmExecutable: nativeExecutable,
    });
    const coordinator = await openCoordinator(
      host,
      f.coordinator.store.directory,
    );
    const restored = new ModuleManager(host, coordinator);
    let compiler = false;
    const observe = () => {
      compiler ||= f.resources.inspect().compilation.active > 0;
    };
    f.resources.addEventListener("change", observe);
    try {
      await restored.restore();
      eq(await host.execute("test.preparation.run"), 2);
      eq(
        snapshot(
          await restored.request(
            "modules.installationStatus",
            { operationId },
            requestSignal(),
          ),
        ).committed,
        true,
      );
      eq(compiler, false);
    } finally {
      f.resources.removeEventListener("change", observe);
      await restored.close();
      await host.close();
      await coordinator.close();
    }
  });
}

Deno.test("status disconnect leaves accepted work alive while manager close cancels and drains it", async () => {
  const barrier = gate();
  await using f = await installationFixture({
    boundary: (at) => at === "generation" ? barrier.hold() : undefined,
  });
  const installResult = await install(f.manager, f.source);
  await bounded(barrier.entered);
  try {
    const current = snapshot(
      await f.manager.request("modules.installationStatus", {
        operationId: installResult.accepted.id,
      }, requestSignal()),
    );
    const disconnected = new AbortController();
    const subscribed = f.manager.request("modules.installationStatus", {
      operationId: current.id,
      afterRevision: current.revision,
    }, disconnected.signal);
    const rejected = rejects(subscribed, /abort/i);
    disconnected.abort();
    await rejected;
    eq(
      snapshot(
        await f.manager.request("modules.installationStatus", {
          operationId: current.id,
        }, requestSignal()),
      ).phase,
      "preparing",
    );
    await bounded(f.manager.close());
    eq((await f.registry()).outcomes.at(-1)?.snapshot.phase, "cancelled");
    // The borrowed coordinator still accepts real ownership operations after close.
    const reviewed = await f.coordinator.store.review(f.source);
    const prepared = await f.coordinator.prepare(reviewed, {
      operationId: crypto.randomUUID(),
      signal: requestSignal(),
    });
    await f.coordinator.store.reclaim(prepared);
    await f.coordinator.store.discardReviewed(reviewed);
  } finally {
    barrier.release();
  }
});

for (const enabled of [true, false]) {
  Deno.test(`legacy native maintenance preserves enabled=${enabled} and grants in a fresh slot`, async () => {
    await using f = await installationFixture({}, "component");
    await f.manager.close();
    const reviewed = await f.coordinator.store.review(f.source);
    const legacy = {
      id: "example.rust",
      slot: reviewed.slot,
      grants: ["log", "tasks.progress"],
      enabled,
    };
    await Deno.writeTextFile(
      `${f.coordinator.store.directory}/installed.json`,
      JSON.stringify([legacy]),
    );
    const manager = new ModuleManager(f.host, f.coordinator);
    let compiler = false;
    const observe = () => {
      compiler ||= f.resources.inspect().compilation.active > 0;
    };
    f.resources.addEventListener("change", observe);
    try {
      await manager.restore();
      eq(compiler, false);
      eq(f.host.commands(), []);
      eq(manager.installationState().maintenance.length, 1);
      const [accepted] = await manager.maintain(legacy.id);
      const result = await outcome(manager, accepted.id);
      eq([result.phase, result.committed], ["succeeded", true]);
      const record = (await f.registry()).records[0];
      notEqual(record.slot, legacy.slot);
      eq([record.grants, record.enabled], [legacy.grants, enabled]);
      eq(f.host.list()[0].state, enabled ? "registered" : "disabled");
      if (enabled) {
        eq(await f.host.execute("example.rust.count-words", "one two"), {
          words: 2,
        });
      } else eq(f.host.commands(), []);
    } finally {
      f.resources.removeEventListener("change", observe);
      await manager.close();
    }
  });
}

Deno.test("registry rejects malformed bounded identities and retains only sixteen outcomes", async () => {
  await using f = await installationFixture({
    boundary: () => {
      throw new Error("x".repeat(2000));
    },
  });
  for (let index = 0; index < 18; index++) {
    const result = await install(f.manager, f.source);
    const finished = await outcome(f.manager, result.accepted.id);
    eq(finished.error?.length, 1024);
  }
  const registry = await f.registry();
  eq(registry.outcomes.length, 16);
  for (
    const input of [
      { ...registry, outcomes: [...registry.outcomes, registry.outcomes[0]] },
      {
        ...registry,
        records: [{
          id: "test.bad",
          slot: "../escape",
          grants: [],
          enabled: true,
        }],
      },
      { ...registry, activeOperation: registry.outcomes[0] },
    ]
  ) {
    throws(() => parseRegistry(input));
  }
});
