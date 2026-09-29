import { deepStrictEqual as equal, ok, rejects } from "node:assert/strict";
import { ModuleHost } from "../host.ts";
import { AotError, type AotErrorCode } from "../../../shared/module_aot.ts";
import {
  type ComponentEnvironment,
  componentExecutable,
  executionResources,
  waitForResources,
  workerCommand,
  workerModuleId,
} from "./aot-component-support.ts";

const MiB = 1024 * 1024;
const timeout = () => AbortSignal.timeout(30_000);
const workerGrants = ["tasks.progress", "tasks.run-worker"] as const;

function aotCode(code: AotErrorCode) {
  return (error: unknown): boolean => {
    ok(error instanceof AotError);
    equal(error.code, code);
    return true;
  };
}

export async function runPreparedFailureCases(
  test: Deno.TestContext,
  environment: ComponentEnvironment,
): Promise<void> {
  for (const damage of ["deleted", "corrupt"] as const) {
    await test.step(`artifact ${damage} after registration fails closed`, async () => {
      const registration = await environment.prepare(
        environment.worker,
        `damage-${damage}`,
      );
      const pin = await environment.store.pin(registration.prepared);
      const target = pin.descriptor?.targets.find((item) =>
        item.kind === "component-entry"
      );
      ok(pin.directory && target);
      const artifact = `${pin.directory}/${target.artifact.file}`;
      pin.release();
      const resources = executionResources();
      const host = new ModuleHost({
        wasmExecutable: componentExecutable,
        resources,
      });
      try {
        await host.registerPrepared(registration, workerGrants);
        if (damage === "deleted") {
          await Deno.remove(artifact);
        } else {
          const bytes = await Deno.readFile(artifact);
          bytes[0] ^= 1;
          await Deno.chmod(artifact, 0o600);
          await Deno.writeFile(artifact, bytes);
        }
        await rejects(
          host.execute(workerCommand, null),
          aotCode(damage === "deleted" ? "unavailable" : "integrity"),
        );
        equal(resources.inspect().processes, []);
        equal(environment.preparationResources.inspect().processes, []);
        await rejects(
          environment.store.reclaim(registration.prepared),
          /active pins or installation references/,
        );
        await host.unregister(workerModuleId);
        await environment.store.reclaim(registration.prepared);
      } finally {
        await host.close();
      }
    });
  }

  await test.step("executable replacement after registration fails before spawn", async () => {
    const registration = await environment.prepare(
      environment.worker,
      "changed-executable",
    );
    const executable = `${environment.base}/replaceable-native-host`;
    await Deno.copyFile(componentExecutable, executable);
    await Deno.chmod(executable, 0o700);
    const resources = executionResources();
    const host = new ModuleHost({
      wasmExecutable: executable,
      resources,
    });
    try {
      await host.registerPrepared(registration, workerGrants);
      await Deno.writeTextFile(executable, "replaced after registration");
      await Deno.chmod(executable, 0o700);
      await rejects(
        host.execute(workerCommand, null),
        aotCode("integrity"),
      );
      equal(resources.inspect().processes, []);
      equal(resources.inspect().queued, 0);
      await host.unregister(workerModuleId);
      await environment.store.reclaim(registration.prepared);
    } finally {
      await host.close();
    }
  });

  await test.step("queued admission cannot spawn after restart transition", async () => {
    const registration = await environment.prepare(
      environment.worker,
      "stale-admission",
    );
    const pin = await environment.store.pin(registration.prepared);
    const artifactBytes = pin.descriptor?.targets.find((item) =>
      item.kind === "component-entry"
    )?.artifact.size;
    pin.release();
    ok(artifactBytes);
    const loadReservation = 128 * MiB + 2 * artifactBytes;
    const resources = executionResources(loadReservation);
    const blocker = await resources.reserveHostUsage({
      id: "test.blocker",
      label: "Admission barrier",
      pid: null,
      rssBytes: null,
      reservedBytes: 1,
      diskBytes: null,
    }, timeout());
    const host = new ModuleHost({
      wasmExecutable: componentExecutable,
      resources,
    });
    try {
      await host.registerPrepared(registration, workerGrants);
      const queued = waitForResources(
        resources,
        () => resources.inspect().queued === 1,
      );
      const execution = host.execute(workerCommand, { stale: true });
      const cancelled = rejects(execution, /abort|cancel|changed/i);
      await queued;
      equal(resources.inspect().processes, []);
      await host.restart(workerModuleId, timeout());
      await cancelled;
      equal(resources.inspect().processes, []);
      equal(resources.inspect().queued, 0);
      blocker.release();
      equal(await host.execute(workerCommand, { fresh: true }), {
        calls: 1,
        input: { fresh: true },
      });
    } finally {
      blocker.release();
      await host.close();
    }
    await environment.store.reclaim(registration.prepared);
  });

  await test.step("cancellation during final readiness pin cannot spawn", async () => {
    const registration = await environment.prepare(
      environment.worker,
      "cancel-final-pin",
    );
    const resources = executionResources();
    const host = new ModuleHost({
      wasmExecutable: componentExecutable,
      resources,
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cancellation = new AbortController();
    const spawned = new Set<number>();
    const originalPin = environment.store.pin.bind(environment.store);
    const observe = () => {
      for (const process of resources.inspect().processes) {
        if (process.pid !== null) spawned.add(process.pid);
      }
    };
    try {
      await host.registerPrepared(registration, workerGrants);
      let pins = 0;
      environment.store.pin = async (prepared) => {
        const pin = await originalPin(prepared);
        if (++pins === 2) {
          entered.resolve();
          await release.promise;
        }
        return pin;
      };
      resources.addEventListener("change", observe);
      const execution = host.execute(workerCommand, null, {
        signal: cancellation.signal,
      });
      const cancelled = rejects(execution, /abort|cancel/i);
      await entered.promise;
      cancellation.abort();
      release.resolve();
      await cancelled;
      equal(spawned.size, 0);
      equal(resources.inspect().processes, []);
    } finally {
      cancellation.abort();
      release.resolve();
      environment.store.pin = originalPin;
      resources.removeEventListener("change", observe);
      await host.close();
    }
    await environment.store.reclaim(registration.prepared);
  });
}
