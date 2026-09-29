import {
  deepStrictEqual as eq,
  notEqual,
  ok,
  rejects,
} from "node:assert/strict";
import { ModuleHost } from "../../modules/host/host.ts";
import { ModuleManager } from "../module_manager.ts";
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
} from "./aot-installation-support.ts";
import { verifyInterruptedInstallation } from "./aot-installation-recovery.ts";
import { verifyMaintenance } from "./aot-installation-maintenance.ts";

async function componentTransactions(): Promise<void> {
  let base = "";
  const pids = new Set<number>();
  {
    let hold = false, failExposure = false, failResponse = false;
    let barrier = gate();
    await using f = await installationFixture({
      preparation: (event) =>
        hold && event.phase === "locked" ? barrier.hold() : undefined,
      afterCommit: () => {
        if (failExposure) throw new Error("probe exposure interrupted");
      },
      beforeResponse: () => {
        if (failResponse) throw new Error("probe response disconnected");
      },
    }, "component");
    base = f.base;
    const observe = () => {
      for (const process of f.resources.inspect().processes) {
        if (process.pid !== null) pids.add(process.pid);
      }
    };
    f.resources.addEventListener("change", observe);
    try {
      const first = await install(f.manager, f.source, [
        "log",
        "tasks.progress",
      ]);
      eq((await outcome(f.manager, first.accepted.id)).phase, "succeeded");
      eq(await f.host.execute("example.rust.count-words", "one two"), {
        words: 2,
      });
      const old = (await f.registry()).records[0];
      hold = true;
      await writePackage(f.source, 2, "component");
      const update = await install(f.manager, f.source, [
        "log",
        "tasks.progress",
      ]);
      await bounded(barrier.entered);
      eq(
        await f.host.execute("example.rust.count-words", "old remains usable"),
        { words: 3 },
      );
      eq(
        snapshot(
          await f.manager.request(
            "modules.install",
            update.parameters,
            requestSignal(),
          ),
        ).id,
        update.accepted.id,
      );
      barrier.release();
      hold = false;
      const complete = await outcome(f.manager, update.accepted.id);
      eq([complete.phase, complete.committed, complete.completedTargets], [
        "succeeded",
        true,
        1,
      ]);
      notEqual((await f.registry()).records[0].slot, old.slot);
      console.log(
        JSON.stringify({
          component: "updated",
          oldWhilePreparing: { words: 3 },
          committed: complete,
        }),
      );

      barrier = gate();
      hold = true;
      const cancelled = await install(f.manager, f.source, [
        "log",
        "tasks.progress",
      ]);
      await bounded(barrier.entered);
      await f.manager.request("modules.cancelInstallation", {
        operationId: cancelled.accepted.id,
      }, requestSignal());
      eq((await outcome(f.manager, cancelled.accepted.id)).phase, "cancelled");
      barrier.release();
      hold = false;
      eq(await f.host.execute("example.rust.count-words", "still old"), {
        words: 2,
      });
      console.log(
        JSON.stringify({
          cancellation: "before-begin",
          phase: "cancelled",
          previousCommand: { words: 2 },
        }),
      );

      failExposure = true;
      const exposed = await install(f.manager, f.source, [
        "log",
        "tasks.progress",
      ]);
      const committed = await outcome(f.manager, exposed.accepted.id);
      eq([committed.phase, committed.committed], ["succeeded", true]);
      ok(committed.error?.includes("recovery"));
      eq(
        snapshot(
          await f.manager.request("modules.cancelInstallation", {
            operationId: committed.id,
          }, requestSignal()),
        ).committed,
        true,
      );
      await f.manager.close();
      await f.host.close();
      await f.coordinator.close();
      const host = new ModuleHost({
        resources: f.resources,
        wasmExecutable: nativeExecutable,
        idleTimeoutMs: 0,
      });
      const coordinator = await openCoordinator(
        host,
        f.coordinator.store.directory,
      );
      const manager = new ModuleManager(host, coordinator, {
        beforeResponse: () => {
          if (failResponse) throw new Error("probe response disconnected");
        },
      });
      try {
        let compilerDuringRestore = false;
        const compiler = () => {
          compilerDuringRestore ||=
            f.resources.inspect().compilation.active > 0;
        };
        f.resources.addEventListener("change", compiler);
        await manager.restore();
        eq(
          await host.execute(
            "example.rust.count-words",
            "restored native result",
          ),
          { words: 3 },
        );
        f.resources.removeEventListener("change", compiler);
        eq(compilerDuringRestore, false);
        console.log(
          JSON.stringify({
            recovery: "committed",
            operationId: committed.id,
            compilerDuringRestore,
            result: { words: 3 },
          }),
        );
        const review = await manager.request("modules.prepare", {
          directory: f.source,
        }, requestSignal());
        ok(
          review && typeof review === "object" && !Array.isArray(review) &&
            typeof review.token === "string",
        );
        const operationId = crypto.randomUUID();
        failResponse = true;
        await rejects(
          manager.request("modules.install", {
            token: review.token,
            operationId,
            grants: ["log", "tasks.progress"],
          }, requestSignal()),
          /disconnected/,
        );
        eq((await outcome(manager, operationId)).committed, true);
        console.log(
          JSON.stringify({ responseFailure: "committed", operationId }),
        );
        await manager.close();
        await host.close();
        const record = (await f.registry()).records[0];
        const reviewed = await coordinator.store.restore(record.slot);
        const prepared = await coordinator.store.restorePrepared(
          record.slot,
          record.artifactSetId ?? null,
        );
        await coordinator.store.reclaim(prepared);
        await coordinator.store.discardReviewed(reviewed);
        console.log(
          JSON.stringify({
            generationOwners: 0,
            reclaim: "passed",
            resources: {
              processes: f.resources.inspect().processes.length,
              queued: f.resources.inspect().queued,
              reservedBytes: f.resources.inspect().reservedBytes,
              compilerActive: f.resources.inspect().compilation.active,
            },
          }),
        );
      } finally {
        await manager.close();
        await host.close();
        await coordinator.close();
      }
    } finally {
      barrier.release();
      f.resources.removeEventListener("change", observe);
    }
  }
  await rejects(Deno.lstat(base), Deno.errors.NotFound);
  console.log(
    JSON.stringify({ cleanup: "removed", root: base, pids: [...pids] }),
  );
}

async function denoTools(): Promise<void> {
  let root = "";
  {
    await using f = await installationFixture({}, "tools");
    root = f.base;
    const accepted = await install(f.manager, f.source, ["wasm.execute"]);
    const completed = await outcome(f.manager, accepted.accepted.id);
    eq([completed.completedTargets, completed.totalTargets], [2, 2]);
    const record = (await f.registry()).records[0];
    const restored = await f.coordinator.store.restorePrepared(
      record.slot,
      record.artifactSetId ?? null,
    );
    eq(
      f.coordinator.store.details(restored).descriptor?.targets.map((target) =>
        target.toolId
      ),
      ["first", "second"],
    );
    eq(await f.host.execute("test.preparation.run"), 1);
    console.log(
      JSON.stringify({
        denoTools: ["first", "second"],
        nativeObjects: 2,
        denoCommand: 1,
      }),
    );
  }
  await rejects(Deno.lstat(root), Deno.errors.NotFound);
  console.log(JSON.stringify({ cleanup: "removed", root }));
}

await componentTransactions();
await denoTools();
await verifyInterruptedInstallation();
for (const kind of ["legacy", "engine"] as const) {
  for (const enabled of [true, false]) await verifyMaintenance(kind, enabled);
}
console.log(
  "PASS task-7 native install/update/cancel/recovery/maintenance; zero final owners, reservations and queues",
);
