import { deepStrictEqual, rejects, throws } from "node:assert/strict";
import { ModuleHost } from "./host.ts";
import { validateManifest } from "./manifest.ts";
import { frame, frames, receivedJson } from "../runtimes/protocol.ts";
import { filePath } from "../paths.ts";
import { IdleClock } from "./fixtures/idle-clock.ts";
import { bounded } from "./fixtures/aot-preparation-support.ts";
import {
  prepareRegistration,
  type PreparedRegistrationHandle,
} from "./development.ts";

const root = filePath(new URL("../../../", import.meta.url));
const executable = `${root}/native/target/release/maghemite-wasm-host${
  Deno.build.os === "windows" ? ".exe" : ""
}`;
async function fixture(
  idleUnload = true,
  deactivate = `await ctx.log("stop");`,
) {
  const directory = await Deno.makeTempDir();
  const manifest = {
    schemaVersion: 1,
    sdkVersion: "0.1.0",
    version: "0.1.0",
    id: "test.idle",
    runtime: "deno",
    entry: "main.ts",
    lifecycle: { idleUnload },
    capabilities: ["log", "tasks.progress"],
    contributions: { commands: [{ id: "test.idle.run", title: "Run" }] },
  };
  await Deno.writeTextFile(
    `${directory}/maghemite.module.json`,
    JSON.stringify(manifest),
  );
  await Deno.writeTextFile(
    `${directory}/main.ts`,
    `let count = 0;
    export default { async activate(ctx) { await ctx.log("start"); },
      commands: { "test.idle.run": async (input, ctx) => { if (input === "hold") await ctx.reportProgress({message:"held",completed:0}); return ++count; } },
      async deactivate(ctx) { ${deactivate} } };`,
  );
  return { directory, manifest };
}

Deno.test("idle modules unload and automatically reactivate; retained modules keep state", async () => {
  for (const idle of [false, true]) {
    using clock = new IdleClock(20);
    const { directory } = await fixture(idle);
    const logs: string[] = [];
    const host = new ModuleHost({
      idleTimeoutMs: 20,
      onLog: (_id, text) => {
        logs.push(text);
      },
    });
    try {
      await host.register(directory, ["log"]);
      deepStrictEqual(await host.execute("test.idle.run"), 1);
      deepStrictEqual(clock.pending, idle ? 1 : 0);
      clock.advance();
      deepStrictEqual(host.list()[0].state, idle ? "suspending" : "active");
      deepStrictEqual(host.commands().length, 1);
      deepStrictEqual(await host.execute("test.idle.run"), idle ? 1 : 2);
      deepStrictEqual(logs, idle ? ["start", "stop", "start"] : ["start"]);
    } finally {
      await host.close();
      await Deno.remove(directory, { recursive: true });
    }
  }
});

Deno.test("idle timer never terminates a busy operation; disable cancels and clears it", async () => {
  using clock = new IdleClock(20);
  const { directory } = await fixture();
  const host = new ModuleHost({ idleTimeoutMs: 20 });
  const entered = Promise.withResolvers<void>();
  try {
    await host.register(directory, ["log", "tasks.progress"]);
    await host.execute("test.idle.run");
    const result = host.execute("test.idle.run", "hold", {
      onProgress: () => {
        entered.resolve();
        return new Promise(() => {});
      },
    });
    const failure = rejects(() => result, /cancelled/);
    await bounded(entered.promise);
    deepStrictEqual(clock.pending, 0);
    clock.advance();
    deepStrictEqual(host.list()[0].state, "active");
    await host.disable("test.idle");
    await failure;
    deepStrictEqual(clock.pending, 0);
    clock.advance();
    deepStrictEqual(host.list()[0].state, "disabled");
  } finally {
    await host.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("command during idle cleanup waits; simultaneous shutdown never resurrects it", async () => {
  for (const shutdown of [false, true]) {
    using clock = new IdleClock(20);
    const { directory } = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const host = new ModuleHost({
      idleTimeoutMs: 20,
      onLog: async (_id, text) => {
        if (text === "stop") {
          entered.resolve();
          await release.promise;
        }
      },
    });
    try {
      await host.register(directory, ["log"]);
      await host.execute("test.idle.run");
      clock.advance();
      await bounded(entered.promise);
      const task = host.execute("test.idle.run");
      if (shutdown) {
        const rejected = rejects(() => task, /abort|cancelled/i);
        const closing = host.close();
        release.resolve();
        await rejected;
        await closing;
        deepStrictEqual(host.list(), []);
      } else {
        release.resolve();
        deepStrictEqual(await task, 1);
      }
    } finally {
      release.resolve();
      await host.close();
      await Deno.remove(directory, { recursive: true });
    }
  }
});

Deno.test("idle cleanup failure is reported and leaves no live instance", async () => {
  using clock = new IdleClock(20);
  const failed = Promise.withResolvers<void>();
  const { directory } = await fixture(
    true,
    `throw new Error("cleanup failed");`,
  );
  const errors: string[] = [];
  const host = new ModuleHost({
    idleTimeoutMs: 20,
    onBackgroundError: (_id, error) => {
      errors.push(String(error));
      failed.resolve();
    },
  });
  try {
    await host.register(directory, ["log"]);
    await host.execute("test.idle.run");
    clock.advance();
    await bounded(failed.promise);
    deepStrictEqual(host.list()[0].state, "failed");
    deepStrictEqual(errors.length, 1);
    deepStrictEqual(host.commands(), []);
  } finally {
    await host.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("cancellation and deadlines interrupt an idle-cleanup wait without corrupting its state", async () => {
  for (const cancellation of [false, true]) {
    using clock = new IdleClock(20);
    const { directory } = await fixture();
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const host = new ModuleHost({
      idleTimeoutMs: 20,
      onLog: async (_id, text) => {
        if (text === "stop") {
          entered.resolve();
          await release.promise;
        }
      },
    });
    try {
      await host.register(directory, ["log"]);
      await host.execute("test.idle.run");
      clock.advance();
      await bounded(entered.promise);
      using deadline = new IdleClock(10);
      const controller = new AbortController();
      const task = host.execute("test.idle.run", null, {
        signal: controller.signal,
        timeoutMs: cancellation ? 500 : 10,
      });
      const failure = rejects(
        () => task,
        cancellation ? /cancelled/ : /timed out/,
      );
      if (cancellation) controller.abort();
      else deadline.advance();
      await failure;
      deepStrictEqual(host.list()[0].state, "suspending");
      release.resolve();
      // The next call awaits the exact suspension promise before starting anew.
      deepStrictEqual(await host.execute("test.idle.run"), 1);
    } finally {
      release.resolve();
      await host.close();
      await Deno.remove(directory, { recursive: true });
    }
  }
});

Deno.test("Wasm idle unload releases the worker and reactivates from its prepared generation", async () => {
  using clock = new IdleClock(20);
  const stopped = Promise.withResolvers<void>();
  const directory = await Deno.makeTempDir();
  const logs: string[] = [];
  const host = new ModuleHost({
    wasmExecutable: executable,
    idleTimeoutMs: 20,
    onLog: (_id, text) => {
      logs.push(text);
      if (logs.length === 2) stopped.resolve();
    },
  });
  let registration: PreparedRegistrationHandle | undefined;
  try {
    registration = await prepareRegistration(
      `${root}/modules-sdk/examples/c`,
      { executable, storageRoot: `${directory}/private` },
    );
    await host.registerPrepared(registration, [
      "log",
      "tasks.progress",
    ]);
    deepStrictEqual(await host.execute("example.c.echo", "first"), "first");
    deepStrictEqual(clock.pending, 1);
    clock.advance();
    await bounded(stopped.promise);
    deepStrictEqual(logs.length, 2);
    deepStrictEqual(await host.execute("example.c.echo", "second"), "second");
    deepStrictEqual(logs.length, 3);
  } finally {
    await host.close();
    await registration?.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("idle configuration is validated; zero timeout preserves opt-in state", async () => {
  using clock = new IdleClock(20);
  const { directory, manifest } = await fixture();
  throws(
    () => validateManifest({ ...manifest, lifecycle: { idleUnload: "yes" } }),
    /lifecycle/,
  );
  throws(() => new ModuleHost({ idleTimeoutMs: -1 }), /idle timeout/);
  const host = new ModuleHost({ idleTimeoutMs: 0 });
  try {
    await host.register(directory, ["log"]);
    await host.execute("test.idle.run");
    deepStrictEqual(clock.pending, 0);
    clock.advance();
    deepStrictEqual(await host.execute("test.idle.run"), 2);
  } finally {
    await host.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("optimized framing handles many frames/chunks and rejects invalid UTF-8/numbers", async () => {
  const values = Array.from(
    { length: 80 },
    (_, index) => ({ index, text: "한글 🌍".repeat(index) }),
  );
  const bytes = new Uint8Array(values.flatMap((value) => [...frame(value)]));
  const actual = [];
  for await (
    const value of frames(
      new ReadableStream({
        start(c) {
          let at = 0;
          for (const size of [1, 2, 3, 500, 23, 10000, bytes.length]) {
            c.enqueue(bytes.slice(at, at + size));
            at += size;
            if (at >= bytes.length) break;
          }
          c.close();
        },
      }),
    )
  ) actual.push(value);
  deepStrictEqual(actual, values);
  await rejects(async () => {
    for await (
      const _ of frames(
        new ReadableStream({
          start(c) {
            c.enqueue(
              Uint8Array.of(123, 34, 120, 34, 58, 34, 255, 34, 125, 10),
            );
            c.close();
          },
        }),
      )
    ) { /* consume */ }
  });
  throws(() => receivedJson(JSON.parse('{"n":1e400}')), /JSON/);
  deepStrictEqual(receivedJson({ empty: [], values: [null, false, 0, ""] }), {
    empty: [],
    values: [null, false, 0, ""],
  });
});

Deno.test("developer preparation and compiler-disabled load are measured separately", async () => {
  const directory = await Deno.makeTempDir();
  const handles: PreparedRegistrationHandle[] = [];
  try {
    const prepareStart = performance.now();
    const first = await prepareRegistration(
      `${root}/modules-sdk/examples/c`,
      { executable, storageRoot: `${directory}/private` },
    );
    handles.push(first);
    const preparationMs = performance.now() - prepareStart;
    deepStrictEqual(first.reused, false);
    const firstHost = new ModuleHost({ wasmExecutable: executable });
    const loadStart = performance.now();
    try {
      await firstHost.registerPrepared(first, ["log", "tasks.progress"]);
      deepStrictEqual(
        await firstHost.execute("example.c.echo", "prepared"),
        "prepared",
      );
      deepStrictEqual(firstHost.resources.inspect().compilation.active, 0);
    } finally {
      await firstHost.close();
      await first.close();
    }
    const firstLoadExecutionMs = performance.now() - loadStart;

    const reuseStart = performance.now();
    const reused = await prepareRegistration(
      `${root}/modules-sdk/examples/c`,
      { executable, storageRoot: `${directory}/private` },
    );
    handles.push(reused);
    const reusePreparationMs = performance.now() - reuseStart;
    deepStrictEqual(reused.reused, true);
    deepStrictEqual(reused.prepared.slot, first.prepared.slot);
    deepStrictEqual(
      reused.prepared.artifactSetId,
      first.prepared.artifactSetId,
    );
    const reusedHost = new ModuleHost({ wasmExecutable: executable });
    try {
      await reusedHost.registerPrepared(reused, ["log", "tasks.progress"]);
      deepStrictEqual(
        await reusedHost.execute("example.c.echo", "reused"),
        "reused",
      );
      deepStrictEqual(reusedHost.resources.inspect().compilation.active, 0);
    } finally {
      await reusedHost.close();
      await reused.close();
    }
    console.log(JSON.stringify({
      preparationMs,
      firstLoadExecutionMs,
      reusePreparationMs,
    }));
  } finally {
    for (const handle of handles.toReversed()) await handle.close();
    await Deno.remove(directory, { recursive: true });
  }
});
