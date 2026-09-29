import { deepStrictEqual, rejects } from "node:assert/strict";
import { parallelMap } from "../../../modules-sdk/js/mod.ts";
import { ModuleHost } from "./host.ts";
import { ModuleProcess } from "../runtimes/process.ts";
import {
  componentEnvironment,
  componentExecutable,
} from "./fixtures/aot-component-support.ts";

Deno.test("parallelMap bounds concurrency, preserves order and drains failures", async () => {
  const gate = Promise.withResolvers<void>();
  const started: number[] = [];
  const result = parallelMap([0, 1, 2, 3], async (n) => {
    started.push(n);
    if (n < 2) await gate.promise;
    return n * 2;
  }, { concurrency: 2 });
  deepStrictEqual(started, [0, 1]);
  gate.resolve();
  deepStrictEqual(await result, [0, 2, 4, 6]);
  const draining = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<void>();
  const calls: number[] = [];
  let settled = false;
  const work = parallelMap([0, 1, 2], async (n) => {
    calls.push(n);
    if (n === 0) {
      failed.resolve();
      throw new Error("task failed");
    }
    await draining.promise;
    return n;
  }, { concurrency: 2 });
  const assertion = rejects(work, /task failed/).then(() => {
    settled = true;
  });
  await failed.promise;
  await Promise.resolve();
  deepStrictEqual(settled, false);
  deepStrictEqual(calls, [0, 1]);
  draining.resolve();
  await assertion;
  await rejects(
    () => parallelMap([], () => Promise.resolve(0), { concurrency: 9 }),
    /Concurrency/,
  );
});

Deno.test("parallelMap abort stops new work and drains started operations", async () => {
  const abort = new AbortController();
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  const work = parallelMap([1, 2, 3], async (n) => {
    calls++;
    await gate.promise;
    return n;
  }, { concurrency: 2, signal: abort.signal });
  abort.abort();
  const assertion = rejects(work, /abort/i);
  gate.resolve();
  await assertion;
  deepStrictEqual(calls, 2);
});

async function fixture(body: string) {
  const directory = await Deno.makeTempDir({ prefix: "maghemite-concurrent-" });
  await Deno.writeTextFile(
    directory + "/maghemite.module.json",
    JSON.stringify({
      schemaVersion: 1,
      sdkVersion: "0.1.0",
      id: "test.concurrent",
      version: "0.1.0",
      runtime: "deno",
      entry: "main.ts",
      capabilities: ["tasks.progress"],
      contributions: {
        commands: [{ id: "test.concurrent.run", title: "Run" }],
      },
    }),
  );
  await Deno.writeTextFile(
    directory + "/main.ts",
    'export default { commands: { "test.concurrent.run": async (_, ctx) => {' +
      body + "}}};",
  );
  return directory;
}

Deno.test("eight host callbacks overlap and cancellation drains the bridge", async () => {
  const directory = await fixture(
    'await Promise.all(Array.from({length:8}, (_, completed) => ctx.reportProgress({message:"work", completed, total:8}))); return 8;',
  );
  const host = new ModuleHost();
  try {
    await host.register(directory, ["tasks.progress"]);
    const all = Promise.withResolvers<void>();
    let started = 0;
    const result = await host.execute("test.concurrent.run", null, {
      timeoutMs: 2000,
      onProgress: async () => {
        if (++started === 8) all.resolve();
        await all.promise;
      },
    });
    deepStrictEqual(result, 8);
    const abort = new AbortController();
    started = 0;
    await rejects(() =>
      host.execute("test.concurrent.run", null, {
        signal: abort.signal,
        onProgress: () => {
          if (++started === 8) abort.abort();
          return new Promise(() => {});
        },
      }), /cancelled/);
    deepStrictEqual(host.list()[0].state, "failed");
    host.enable("test.concurrent");
    deepStrictEqual(await host.execute("test.concurrent.run"), 8);
  } finally {
    await host.close();
    await Deno.remove(directory, { recursive: true });
  }
});

for (const mode of ["overflow", "duplicate", "early-response"] as const) {
  Deno.test(
    "concurrent transport rejects " + mode + " without hanging teardown",
    async () => {
      const directory = await Deno.makeTempDir();
      const protocol = new URL("../runtimes/protocol.ts", import.meta.url).href;
      const count = mode === "overflow" ? 9 : mode === "duplicate" ? 2 : 1;
      const source = [
        "import { frame, frames } from " + JSON.stringify(protocol) + ";",
        "const writer = Deno.stdout.writable.getWriter();",
        "for await (const request of frames(Deno.stdin.readable)) {",
        "for (let i=1; i<=" + count + "; i++) {",
        'await writer.write(frame({type:"event", id:' +
        (mode === "duplicate" ? "1" : "i") +
        ', call:request.id,method:"tasks.progress",payload:{message:"test",completed:0}})); }',
        mode === "early-response"
          ? 'await writer.write(frame({type:"response",id:request.id,ok:true,value:null}));'
          : "",
        "await new Promise(()=>{}); }",
      ].join("\n");
      await Deno.writeTextFile(directory + "/worker.ts", source);
      const process = new ModuleProcess(
        new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            "--no-config",
            "--no-lock",
            "--allow-read",
            directory + "/worker.ts",
          ],
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
        }),
      );
      try {
        await rejects(
          () =>
            process.call(
              "execute",
              {},
              () => new Promise(() => {}),
              undefined,
              2000,
            ),
          mode === "overflow"
            ? /Too many host calls/
            : mode === "duplicate"
            ? /Invalid module event/
            : /unacknowledged/,
        );
      } finally {
        await process.close();
        await Deno.remove(directory, { recursive: true });
      }
    },
  );
}

Deno.test("separate synchronous C# instances can progress concurrently", async () => {
  await using environment = await componentEnvironment({
    buildWorker: false,
  });
  const registration = await environment.prepare(
    environment.sync,
    "async-test-sync",
  );
  const options = {
    wasmExecutable: componentExecutable,
  };
  const hosts = [new ModuleHost(options), new ModuleHost(options)];
  const both = Promise.withResolvers<void>();
  let started = 0;
  try {
    await Promise.all(hosts.map((host) =>
      host.registerPrepared(
        registration,
        ["log", "tasks.progress"],
      )
    ));
    const results = await Promise.all(
      hosts.map((host, input) =>
        host.execute("example.csharp.echo", input, {
          timeoutMs: 10_000,
          onProgress: async (event) => {
            if (event.completed === 0) {
              if (++started === 2) both.resolve();
              await both.promise;
            }
          },
        })
      ),
    );
    deepStrictEqual(results, [0, 1]);
  } finally {
    await Promise.all(hosts.map((host) => host.close()));
  }
  await environment.store.reclaim(registration.prepared);
});
