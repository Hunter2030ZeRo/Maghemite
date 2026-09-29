import { deepStrictEqual, ok, rejects, throws } from "node:assert/strict";
import { ModuleHost } from "./host.ts";
import { delay, WorkerPool } from "./tasks.ts";
import { validateManifest } from "./manifest.ts";

Deno.test("worker slots bound active work and queues, cancel queued work, and drain on close", async () => {
  throws(() => new WorkerPool(0), /concurrency/);
  const pool = new WorkerPool(1, 1);
  const parent = new AbortController();
  const started = Promise.withResolvers<void>();
  let active = false;
  const first = pool.run(async (signal) => {
    active = true;
    started.resolve();
    try {
      await delay(300_000, signal);
    } finally {
      active = false;
    }
  }, parent.signal);
  const firstRejected = rejects(() => first, /cancel/i);
  await started.promise;
  const queued = new AbortController();
  let dispatched = false;
  const second = pool.run(async () => {
    dispatched = true;
  }, queued.signal);
  const secondRejected = rejects(() => second, /cancel/i);
  await rejects(() => pool.run(async () => {}, parent.signal), /queue is full/);
  queued.abort();
  await secondRejected;
  await pool.close();
  await firstRejected;
  deepStrictEqual([active, dispatched], [false, false]);
  await rejects(() => pool.run(async () => {}, parent.signal));
  for (const value of [-1, 0.5, NaN, 300_001, "1"]) {
    await rejects(() => delay(value, new AbortController().signal), /Delay/);
  }
});

async function fixture() {
  const directory = await Deno.makeTempDir({
    prefix: "maghemite-task-services-",
  });
  const manifest = {
    schemaVersion: 1,
    sdkVersion: "0.1.0",
    id: "test.tasks",
    version: "0.1.0",
    runtime: "deno",
    entry: "main.ts",
    capabilities: ["log", "tasks.progress", "tasks.run-worker"],
    workers: ["test.tasks.compute"],
    contributions: {
      commands: ["run", "compute"].map((name) => ({
        id: `test.tasks.${name}`,
        title: name,
      })),
    },
  };
  await Deno.writeTextFile(
    `${directory}/maghemite.module.json`,
    JSON.stringify(manifest),
  );
  await Deno.writeTextFile(
    `${directory}/main.ts`,
    `
let calls = 0;
export default {
  commands: {
    "test.tasks.run": async (input, ctx) => {
      if (input === "timer") { await ctx.delay(40); return true; }
      if (input === "bad") return await ctx.runWorker("test.tasks.run", null);
      if (input === "cancel-timer") { await ctx.reportProgress({message:"timer", completed:0}); await ctx.delay(300000); return null; }
      return await Promise.all(Array.from({length: input.count ?? 2}, (_, i) => ctx.runWorker("test.tasks.compute", {...input, value:i+1})));
    },
    "test.tasks.compute": async (input, ctx) => {
      if (input.mode === "nested") return await ctx.runWorker("test.tasks.compute", input);
      await ctx.reportProgress({message:"started:"+Deno.pid, completed:input.value});
      if (input.mode === "infinite") { while (true) {} }
      if (input.mode === "error") throw new Error("worker computation failed");
      if (input.mode === "exit") Deno.exit(1);
      let sum = 0; for (let n = 0; n < 100000; n++) sum += n;
      await ctx.delay(5);
      return {value:input.value*input.value, sum, calls:++calls, pid:Deno.pid};
    }
  }
};`,
  );
  return { directory, manifest };
}

Deno.test("Deno task services: isolated CPU work, bounds, permissions and cancellation", async (test) => {
  const { directory, manifest } = await fixture();
  let host = new ModuleHost({ workerConcurrency: 2 });
  try {
    await host.register(directory, ["tasks.progress", "tasks.run-worker"]);
    await test.step("timers suspend and separate processes compute with isolated state", async () => {
      await host.execute("test.tasks.run", "timer"); // warm activation
      const before = performance.now();
      await host.execute("test.tasks.run", "timer");
      ok(performance.now() - before >= 30);
      const all = Promise.withResolvers<void>();
      let started = 0;
      const result = await host.execute("test.tasks.run", {}, {
        timeoutMs: 5000,
        onProgress: async () => {
          if (++started === 2) all.resolve();
          await all.promise;
        },
      }) as { value: number; sum: number; calls: number; pid: number }[];
      deepStrictEqual(
        result.map(({ value, sum, calls }) => ({ value, sum, calls })),
        [
          { value: 1, sum: 4999950000, calls: 1 },
          { value: 4, sum: 4999950000, calls: 1 },
        ],
      );
      ok(
        result[0].pid !== result[1].pid &&
          result.every((item) => item.pid !== Deno.pid),
      );
    });
    await test.step("worker allowlists and recursion are enforced", async () => {
      await rejects(() => host.execute("test.tasks.run", "bad"), /allowlisted/);
      host.enable("test.tasks");
      await rejects(
        () => host.execute("test.tasks.run", { mode: "nested" }),
        /nested workers/,
      );
      host.enable("test.tasks");
      throws(
        () => validateManifest({ ...manifest, workers: ["foreign.command"] }),
        /Workers/,
      );
      throws(
        () =>
          validateManifest({
            ...manifest,
            workers: ["test.tasks.compute", "test.tasks.compute"],
          }),
        /Workers/,
      );
    });
    await test.step("worker errors and crashes return errors without retaining children", async () => {
      for (
        const [mode, pattern] of [["error", /computation failed/], [
          "exit",
          /transport closed/,
        ]] as const
      ) {
        await rejects(() => host.execute("test.tasks.run", { mode }), pattern);
        host.enable("test.tasks");
      }
    });
    await test.step("cancellation kills CPU-bound children and removes queued jobs", async () => {
      const abort = new AbortController();
      let started = 0;
      const pids: number[] = [];
      await rejects(
        () =>
          host.execute("test.tasks.run", { mode: "infinite", count: 4 }, {
            signal: abort.signal,
            timeoutMs: 5000,
            onProgress: (event) => {
              pids.push(Number(event.message.split(":")[1]));
              if (++started === 2) abort.abort();
            },
          }),
        /cancelled/,
      );
      // close drains all worker ownership, including jobs still waiting for slots.
      await host.close();
      deepStrictEqual(started, 2);
      if (Deno.build.os === "linux") {
        // Deno protects /proc even with --allow-read. Query process existence
        // using the subprocess permission already required by this suite.
        const processes = await new Deno.Command("ps", {
          args: ["-p", pids.join(","), "-o", "pid="],
          stdout: "piped",
          stderr: "piped",
        }).output();
        deepStrictEqual(processes.code, 1);
        deepStrictEqual(new TextDecoder().decode(processes.stdout).trim(), "");
      }
      host = new ModuleHost({ workerConcurrency: 2 });
      await host.register(directory, ["tasks.progress", "tasks.run-worker"]);
      deepStrictEqual(await host.execute("test.tasks.run", "timer"), true);
    });
    await test.step("deadlines stop CPU jobs and shutdown releases pending timers", async () => {
      await rejects(
        () =>
          host.execute("test.tasks.run", { mode: "infinite" }, {
            timeoutMs: 600,
          }),
        /timed out|cancelled/,
      );
      host.enable("test.tasks");
      const started = Promise.withResolvers<void>();
      const call = host.execute("test.tasks.run", "cancel-timer", {
        onProgress: () => {
          started.resolve();
        },
      });
      const failure = rejects(() => call, /cancelled|closed/);
      await started.promise;
      await host.close();
      await failure;
      host = new ModuleHost();
      await host.register(directory, []);
      deepStrictEqual(await host.execute("test.tasks.run", "timer"), true);
      await rejects(
        () => host.execute("test.tasks.run", {}),
        /Capability denied: tasks.run-worker/,
      );
      await host.close();
      host = new ModuleHost();
      await host.register(directory, ["tasks.run-worker"]);
      await rejects(
        () => host.execute("test.tasks.run", {}),
        /Capability denied: tasks.progress/,
      );
    });
  } finally {
    await host.close();
    await Deno.remove(directory, { recursive: true });
  }
});
