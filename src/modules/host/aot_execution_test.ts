import {
  deepStrictEqual as equal,
  notEqual,
  ok,
  rejects,
} from "node:assert/strict";
import { ModuleHost } from "./host.ts";
import { AotError, type AotErrorCode } from "../../shared/module_aot.ts";
import {
  componentEnvironment,
  componentExecutable,
  executionResources,
  parentCommand,
  waitForResources,
  workerCommand,
  workerModuleId,
} from "./fixtures/aot-component-support.ts";
import { runPreparedFailureCases } from "./fixtures/aot-component-failure-cases.ts";
import { verifyWasiHostExecution } from "./fixtures/aot-wasi-support.ts";

const timeout = () => AbortSignal.timeout(30_000);
const workerGrants = ["tasks.progress", "tasks.run-worker"] as const;

function aotCode(code: AotErrorCode) {
  return (error: unknown): boolean => {
    ok(error instanceof AotError);
    equal(error.code, code);
    return true;
  };
}

Deno.test("component prepared execution owns registration runtime workers and transitions", async (test) => {
  await using environment = await componentEnvironment();

  await test.step("registration rejects source copied authority and undeclared grants", async () => {
    const registration = await environment.prepare(
      environment.worker,
      "registration",
    );
    const host = new ModuleHost({
      wasmExecutable: componentExecutable,
      resources: executionResources(),
    });
    try {
      await rejects(
        host.register(environment.worker, workerGrants),
        /require prepared registration/,
      );
      await rejects(
        host.registerPrepared({
          store: registration.store,
          prepared: structuredClone(registration.prepared),
        }, workerGrants),
        /Unknown prepared package capability/,
      );
      await rejects(
        host.registerPrepared(registration, ["process.execute"]),
        /Cannot grant undeclared capability/,
      );
      equal(host.list(), []);
    } finally {
      await host.close();
    }
    const missing = new ModuleHost({
      wasmExecutable: `${environment.base}/missing-native-host`,
      resources: executionResources(),
    });
    try {
      await rejects(
        missing.registerPrepared(registration, workerGrants),
        aotCode("unavailable"),
      );
      equal(missing.list(), []);
    } finally {
      await missing.close();
    }
    const wrongExecutable = `${environment.base}/wrong-native-host`;
    await Deno.writeTextFile(wrongExecutable, "not the prepared producer");
    const mismatch = new ModuleHost({
      wasmExecutable: wrongExecutable,
      resources: executionResources(),
    });
    try {
      await rejects(
        mismatch.registerPrepared(registration, workerGrants),
        aotCode("integrity"),
      );
      equal(mismatch.list(), []);
      equal(environment.preparationResources.inspect().processes, []);
    } finally {
      await mismatch.close();
    }
    await environment.store.reclaim(registration.prepared);
  });

  await test.step("async workers restart and idle reactivation execute prepared code", async () => {
    const registration = await environment.prepare(
      environment.worker,
      "async-workers",
    );
    const resources = executionResources();
    const host = new ModuleHost({
      wasmExecutable: componentExecutable,
      resources,
      workerConcurrency: 2,
      idleTimeoutMs: 1,
    });
    let compilerPermitObserved = false;
    const observe = () => {
      compilerPermitObserved ||= resources.inspect().processes.some((process) =>
        process.compilerPermit
      );
    };
    resources.addEventListener("change", observe);
    try {
      await host.registerPrepared(registration, workerGrants);
      await rejects(
        environment.store.reclaim(registration.prepared),
        /active pins or installation references/,
      );

      const both = Promise.withResolvers<void>();
      let started = 0;
      const workerPids = new Set<number>();
      const result = await host.execute(parentCommand, { value: 7 }, {
        timeoutMs: 30_000,
        onProgress: async (event) => {
          if (event.message !== "worker-started") return;
          for (const process of resources.inspect().processes) {
            if (process.worker && process.pid !== null) {
              workerPids.add(process.pid);
            }
          }
          if (++started === 2) both.resolve();
          await both.promise;
        },
      });
      equal(result, [
        { calls: 1, input: { value: 7 } },
        { calls: 1, input: { value: 7 } },
      ]);
      equal(workerPids.size, 2);

      equal(await host.execute(workerCommand, { phase: "before" }), {
        calls: 1,
        input: { phase: "before" },
      });
      equal(await host.execute(workerCommand, { phase: "before-2" }), {
        calls: 2,
        input: { phase: "before-2" },
      });
      await host.restart(workerModuleId, timeout());
      equal(await host.execute(workerCommand, { phase: "after" }), {
        calls: 1,
        input: { phase: "after" },
      });

      const before = resources.inspect().processes.find((item) => !item.worker)
        ?.pid;
      ok(before);
      await waitForResources(
        resources,
        () => resources.inspect().processes.length === 0,
      );
      equal(await host.execute(workerCommand, { phase: "idle" }), {
        calls: 1,
        input: { phase: "idle" },
      });
      const after = resources.inspect().processes.find((item) => !item.worker)
        ?.pid;
      ok(after);
      notEqual(after, before);
    } finally {
      resources.removeEventListener("change", observe);
      await host.close();
    }
    equal(compilerPermitObserved, false);
    equal(resources.inspect().processes, []);
    await environment.store.reclaim(registration.prepared);
  });

  await test.step("sync component returns an actual result without compiler admission", async () => {
    const registration = await environment.prepare(environment.sync, "sync");
    const resources = executionResources();
    const host = new ModuleHost({
      wasmExecutable: componentExecutable,
      resources,
    });
    try {
      await host.registerPrepared(registration, ["log", "tasks.progress"]);
      equal(await host.execute("example.csharp.echo", { sync: true }), {
        sync: true,
      });
      equal(resources.inspect().compilation.active, 0);
      ok(
        resources.inspect().processes.every((process) =>
          !process.compilerPermit
        ),
      );
    } finally {
      await host.close();
    }
    await environment.store.reclaim(registration.prepared);
  });

  await runPreparedFailureCases(test, environment);
});

Deno.test("prepared Deno package brokers both WASI tools from immutable assets", async () => {
  await verifyWasiHostExecution();
});
