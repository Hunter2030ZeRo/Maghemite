import { filePath } from "../paths.ts";
import { ModuleHost } from "./host.ts";
import {
  type Capability,
  loadPackage,
  validateManifest,
} from "./manifest.ts";
import { frame, frames } from "../runtimes/protocol.ts";
import {
  prepareRegistration,
  type PreparedRegistrationHandle,
  requiresPreparedRegistration,
} from "./development.ts";

const root = new URL("../../../", import.meta.url);
const path = (relative: string) => filePath(new URL(relative, root));
const executable = path(
  `native/target/release/maghemite-wasm-host${
    Deno.build.os === "windows" ? ".exe" : ""
  }`,
);
const manifest = (id = "test.module") => ({
  schemaVersion: 1,
  id,
  sdkVersion: "0.1.0",
  version: "0.1.0",
  runtime: "deno",
  entry: "main.ts",
  capabilities: ["log", "tasks.progress"],
  contributions: { commands: [{ id: `${id}.run`, title: "Run" }] },
});
function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
async function rejects(
  operation: () => unknown | Promise<unknown>,
  includes: string,
) {
  try {
    await operation();
  } catch (error) {
    if (!String(error).includes(includes)) {
      throw new Error(`Expected ${includes}, got ${error}`);
    }
    return;
  }
  throw new Error(`Expected failure: ${includes}`);
}
async function fixture(source: string) {
  const directory = await Deno.makeTempDir({ prefix: "maghemite-module-" });
  await Deno.writeTextFile(
    `${directory}/maghemite.module.json`,
    JSON.stringify(manifest()),
  );
  await Deno.writeTextFile(`${directory}/main.ts`, source);
  return directory;
}
async function registerPackage(
  host: ModuleHost,
  directory: string,
  grants: readonly Capability[],
  storageRoot: string,
): Promise<PreparedRegistrationHandle | undefined> {
  const pkg = await loadPackage(directory);
  if (!requiresPreparedRegistration(pkg.manifest)) {
    await host.register(directory, grants);
    return undefined;
  }
  const registration = await prepareRegistration(directory, {
    executable,
    storageRoot,
  });
  try {
    await host.registerPrepared(registration, grants);
    return registration;
  } catch (error) {
    await registration.close();
    throw error;
  }
}

Deno.test("Deno accepts consecutive calls as soon as a response is received", async () => {
  const directory = await fixture(`export default {
    commands: { "test.module.run": input => input }
  };`);
  const host = new ModuleHost();
  try {
    await host.register(directory);
    for (let i = 0; i < 200; i++) {
      equal(await host.execute("test.module.run", i), i);
    }
  } finally {
    await host.close();
    await Deno.remove(directory, { recursive: true });
  }
});

for (const runtime of ["deno", "rust"]) {
  Deno.test(`${runtime}: real module lifecycle, backpressure and command ownership`, async () => {
    const logs: string[] = [];
    const host = new ModuleHost({
      wasmExecutable: executable,
      onLog: (_id, text) => {
        logs.push(text);
      },
    });
    const privateRoot = await Deno.makeTempDir({
      prefix: "maghemite-host-development-",
    });
    let registration: PreparedRegistrationHandle | undefined;
    try {
      registration = await registerPackage(
        host,
        path(`modules-sdk/examples/${runtime}`),
        [
        "log",
        "tasks.progress",
        ],
        privateRoot,
      );
      equal(logs, []);
      equal(host.list()[0].state, "registered");
      const progress: number[] = [];
      const input = "hello module world";
      const result = await host.execute(
        `example.${runtime}.count-words`,
        input,
        {
          onProgress: async (event) => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            progress.push(event.completed);
          },
        },
      );
      equal(result, { words: 3 });
      equal(progress, [0, 1]);
      equal(logs.length, 1);
      equal(await host.execute(`example.${runtime}.count-words`, ""), {
        words: 0,
      });
      equal(logs.length, 1); // Reuse the instance.
      await rejects(() => host.execute("other.module.run"), "unavailable");
      await host.disable(`example.${runtime}`);
      equal(host.commands(), []);
      equal(logs.length, 2);
      await rejects(
        () => host.execute(`example.${runtime}.count-words`),
        "unavailable",
      );
      host.enable(`example.${runtime}`);
      equal(await host.execute(`example.${runtime}.count-words`, "again"), {
        words: 1,
      });
      await host.unregister(`example.${runtime}`);
      equal(host.list(), []);
      equal(logs.length, 4);
    } finally {
      await host.close();
      await registration?.close();
      await Deno.remove(privateRoot, { recursive: true });
    }
  });

  Deno.test(`${runtime}: capability requests do not grant permissions`, async () => {
    const logs: string[] = [];
    const host = new ModuleHost({
      wasmExecutable: executable,
      onLog: (_id, text) => {
        logs.push(text);
      },
    });
    const privateRoot = await Deno.makeTempDir({
      prefix: "maghemite-host-development-",
    });
    let registration: PreparedRegistrationHandle | undefined;
    try {
      registration = await registerPackage(
        host,
        path(`modules-sdk/examples/${runtime}`),
        [],
        privateRoot,
      );
      await rejects(
        () => host.execute(`example.${runtime}.count-words`, "text"),
        "Capability denied: log",
      );
      equal(logs, []);
      equal(host.list()[0].state, "failed");
      equal(host.commands(), []);
    } finally {
      await host.close();
      await registration?.close();
      await Deno.remove(privateRoot, { recursive: true });
    }
  });

  Deno.test(`${runtime}: cancelling a suspended call closes the process and permits recovery`, async () => {
    const host = new ModuleHost({ wasmExecutable: executable });
    const abort = new AbortController();
    const started = Promise.withResolvers<void>();
    const privateRoot = await Deno.makeTempDir({
      prefix: "maghemite-host-development-",
    });
    let registration: PreparedRegistrationHandle | undefined;
    try {
      registration = await registerPackage(
        host,
        path(`modules-sdk/examples/${runtime}`),
        [
        "log",
        "tasks.progress",
        ],
        privateRoot,
      );
      const task = host.execute(`example.${runtime}.count-words`, "text", {
        signal: abort.signal,
        onProgress: () => {
          started.resolve();
          return new Promise(() => {});
        },
      });
      const failure = rejects(() => task, "cancelled");
      await started.promise;
      await rejects(
        () => host.execute(`example.${runtime}.count-words`, "other"),
        "busy",
      );
      abort.abort();
      await failure;
      equal(host.list()[0].state, "failed");
      host.enable(`example.${runtime}`);
      equal(await host.execute(`example.${runtime}.count-words`, "recovered"), {
        words: 1,
      });
    } finally {
      await host.close();
      await registration?.close();
      await Deno.remove(privateRoot, { recursive: true });
    }
  });
}

Deno.test("Deno runtime isolates filesystem, environment and subprocess access", async () => {
  const secret = await Deno.makeTempFile();
  await Deno.writeTextFile(secret, "must not be read");
  const directory = await fixture(
    `export default { commands: { "test.module.run": async () => {
    const denied = [];
    for (const action of [() => Deno.readTextFile(${
      JSON.stringify(secret)
    }), () => Deno.env.get("HOME"), () => new Deno.Command(${
      JSON.stringify(Deno.execPath())
    }, {args:["--version"]}).output()]) {
      try { await action(); denied.push(false); } catch (error) { denied.push(error instanceof Deno.errors.NotCapable); }
    }
    return denied;
  } } };`,
  );
  const host = new ModuleHost();
  try {
    await host.register(directory);
    equal(await host.execute("test.module.run"), [true, true, true]);
  } finally {
    await host.close();
    await Deno.remove(directory, { recursive: true });
    await Deno.remove(secret);
  }
});

Deno.test("shutdown disposes registrations in reverse order", async () => {
  const directory = await fixture(`export default {
    activate(ctx) { ctx.onDispose(() => ctx.log("first")); ctx.onDispose(() => ctx.log("second")); },
    commands: { "test.module.run": () => null },
    async deactivate(ctx) { await ctx.log("deactivate"); }
  };`);
  const logs: string[] = [];
  const host = new ModuleHost({
    onLog: (_id, value) => {
      logs.push(value);
    },
  });
  try {
    await host.register(directory, ["log"]);
    await host.execute("test.module.run");
    await host.close();
    equal(logs, ["deactivate", "second", "first"]);
  } finally {
    await host.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("infinite JavaScript execution is terminated by deadline", async () => {
  const directory = await fixture(
    `export default { commands: { "test.module.run": () => { while (true) {} } } };`,
  );
  const host = new ModuleHost();
  try {
    await host.register(directory);
    await rejects(
      () => host.execute("test.module.run", null, { timeoutMs: 300 }),
      "timed out",
    );
    equal(host.list()[0].state, "failed");
  } finally {
    await host.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("wrong implementation IDs fail activation; invalid JSON fails before activation", async () => {
  const directory = await fixture(
    `export default { commands: { "other.module.run": () => null } };`,
  );
  const host = new ModuleHost();
  try {
    await host.register(directory);
    await rejects(() => host.execute("test.module.run", NaN), "JSON value");
    equal(host.list()[0].state, "registered");
    await rejects(() => host.execute("test.module.run"), "do not match");
    equal(host.list()[0].state, "failed");
  } finally {
    await host.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("manifest version, command namespace, unknown permissions and escaping entries are rejected", async () => {
  for (
    const patch of [{ sdkVersion: "9.0.0" }, { entry: "../main.ts" }, {
      capabilities: ["ffi"],
    }, { contributions: { commands: [{ id: "foreign.run", title: "Wrong" }] } }]
  ) {
    await rejects(() => validateManifest({ ...manifest(), ...patch }), "Error");
  }
  const directory = await fixture("export default {};");
  const outside = await Deno.makeTempFile();
  const host = new ModuleHost();
  try {
    await Deno.remove(`${directory}/main.ts`);
    await Deno.symlink(outside, `${directory}/main.ts`);
    await rejects(() => host.register(directory), "escapes");
    equal(host.list(), []);
  } finally {
    await host.close();
    await Deno.remove(directory, { recursive: true });
    await Deno.remove(outside);
  }
});

Deno.test("framing handles fragmented UTF-8 and rejects unbounded or truncated messages", async () => {
  const bytes = frame({ text: "한글" });
  const values = [];
  for await (
    const value of frames(
      new ReadableStream({
        start(c) {
          for (const byte of bytes) c.enqueue(Uint8Array.of(byte));
          c.close();
        },
      }),
    )
  ) values.push(value);
  equal(values, [{ text: "한글" }]);
  for (
    const data of [
      new Uint8Array(65536).fill(65),
      new TextEncoder().encode('{"x":1}'),
    ]
  ) {
    await rejects(async () => {
      for await (
        const _ of frames(
          new ReadableStream({
            start(c) {
              c.enqueue(data);
              c.close();
            },
          }),
        )
      ) { /* consume */ }
    }, "frame");
  }
});

Deno.test("concurrent disable and shutdown terminate an in-flight module once", async () => {
  const directory = await fixture(
    `export default { commands: { "test.module.run": async (_, ctx) => {
    console.log("ordinary diagnostics");
    await ctx.reportProgress({ message: "started", completed: 0 });
    await new Promise(() => {});
  } } };`,
  );
  const started = Promise.withResolvers<void>();
  const host = new ModuleHost();
  try {
    await host.register(directory, ["tasks.progress"]);
    const task = host.execute("test.module.run", null, {
      onProgress: () => {
        started.resolve();
      },
    });
    const cancelled = rejects(() => task, "cancelled");
    await started.promise;
    await Promise.all([
      host.disable("test.module"),
      host.close(),
      host.close(),
      cancelled,
    ]);
    equal(host.list(), []);
  } finally {
    await host.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("invalid Wasm component fails promptly without leaving a process behind", async () => {
  const directory = await fixture("unused");
  await Deno.writeTextFile(
    `${directory}/maghemite.module.json`,
    JSON.stringify({ ...manifest(), runtime: "wasm", entry: "bad.wasm" }),
  );
  // A valid *core* module is insufficient: the host requires our component world.
  await Deno.writeFile(
    `${directory}/bad.wasm`,
    Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0),
  );
  const host = new ModuleHost({ wasmExecutable: executable });
  const privateRoot = await Deno.makeTempDir({
    prefix: "maghemite-invalid-development-",
  });
  let registration: PreparedRegistrationHandle | undefined;
  try {
    await rejects(
      async () => {
        registration = await registerPackage(
          host,
          directory,
          [],
          privateRoot,
        );
      },
      "Native preparation failed",
    );
    equal(host.list(), []);
  } finally {
    await host.close();
    await registration?.close();
    await Deno.remove(directory, { recursive: true });
    await Deno.remove(privateRoot, { recursive: true });
  }
});
