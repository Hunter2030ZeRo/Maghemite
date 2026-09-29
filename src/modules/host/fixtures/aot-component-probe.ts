import {
  componentEnvironment,
  componentExecutable,
  executionResources,
  parentCommand,
  workerCommand,
  workerModuleId,
} from "./aot-component-support.ts";
import { ModuleHost } from "../host.ts";

let removedRoot = "";
{
  await using environment = await componentEnvironment();
  removedRoot = environment.base;
  const registration = await environment.prepare(
    environment.worker,
    "public-probe",
  );
  const resources = executionResources();
  const host = new ModuleHost({
    wasmExecutable: componentExecutable,
    resources,
    workerConcurrency: 2,
  });
  let compilerPermitObserved = false;
  const observe = () => {
    compilerPermitObserved ||= resources.inspect().processes.some((process) =>
      process.compilerPermit
    );
  };
  resources.addEventListener("change", observe);
  try {
    await host.registerPrepared(registration, [
      "tasks.progress",
      "tasks.run-worker",
    ]);
    const both = Promise.withResolvers<void>();
    let started = 0;
    const workers = new Set<number>();
    const result = await host.execute(parentCommand, { probe: true }, {
      onProgress: async (event) => {
        if (event.message !== "worker-started") return;
        for (const process of resources.inspect().processes) {
          if (process.worker && process.pid !== null) {
            workers.add(process.pid);
          }
        }
        if (++started === 2) both.resolve();
        await both.promise;
      },
    });
    if (
      JSON.stringify(result) !== JSON.stringify([
          { calls: 1, input: { probe: true } },
          { calls: 1, input: { probe: true } },
        ]) || workers.size !== 2
    ) {
      throw new Error(
        "Prepared worker instances did not execute independently",
      );
    }
    console.log(JSON.stringify({
      phase: "workers",
      result,
      pids: [...workers],
      compilerActive: resources.inspect().compilation.active,
    }));

    await host.restart(workerModuleId, AbortSignal.timeout(30_000));
    const restarted = await host.execute(workerCommand, { restarted: true });
    if (
      JSON.stringify(restarted) !==
        JSON.stringify({ calls: 1, input: { restarted: true } })
    ) {
      throw new Error("Prepared restart returned the wrong result");
    }
    console.log(JSON.stringify({
      phase: "restart",
      result: restarted,
      compilerActive: resources.inspect().compilation.active,
    }));
    if (compilerPermitObserved) {
      throw new Error("Execution consumed a compiler permit");
    }
  } finally {
    resources.removeEventListener("change", observe);
    await host.close();
  }
  const final = resources.inspect();
  if (
    final.processes.length || final.queued || final.reservedBytes ||
    final.compilation.active
  ) {
    throw new Error("Execution ownership was not released");
  }
  await environment.store.reclaim(registration.prepared);
  console.log(JSON.stringify({
    phase: "ownership",
    compilerPermitObserved,
    processes: final.processes.length,
    queued: final.queued,
    reservedBytes: final.reservedBytes,
  }));
}

try {
  await Deno.stat(removedRoot);
  throw new Error("Probe temporary root still exists");
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}
console.log(JSON.stringify({ phase: "cleanup", removedRoot }));
