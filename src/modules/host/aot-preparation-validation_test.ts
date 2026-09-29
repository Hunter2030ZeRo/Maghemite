import { deepStrictEqual as eq, equal, ok, rejects } from "node:assert/strict";
import { ModuleProcess } from "../runtimes/process.ts";
import { PreparationProcesses } from "../runtimes/preparation-process.ts";
import { preparationBytes } from "./fixtures/aot-preparation-binaries.ts";
import {
  assertIdle,
  entries,
  executable,
  preparationFixture,
  timeout,
} from "./fixtures/aot-preparation-support.ts";
import { verifyPreparedWasiTrap } from "./fixtures/aot-wasi-trap.ts";

for (const malformed of [true, false]) {
  Deno.test(`preparation rejects ${malformed ? "malformed component source" : "mismatched component profile"}`, async () => {
    // Given source review checks the container header, not runtime ABI.
    await using f = await preparationFixture({ component: "sync", tools: [] });
    if (malformed) {
      await Deno.writeFile(
        `${f.source}/entry.wasm`,
        new Uint8Array([0, 97, 115, 109, 13, 0, 1, 0, 1, 255]),
      );
    } else {
      const manifest: unknown = JSON.parse(
        await Deno.readTextFile(`${f.source}/maghemite.module.json`),
      );
      ok(typeof manifest === "object" && manifest !== null);
      await Deno.writeTextFile(
        `${f.source}/maghemite.module.json`,
        JSON.stringify({ ...manifest, wasmProfile: "async" }),
      );
    }
    const reviewed = await f.store.review(f.source);
    // When native compilation/linker validation processes it.
    await rejects(
      f.coordinator.prepare(reviewed, {
        operationId: "invalid-component",
        signal: timeout(),
      }),
      /Native preparation failed/,
    );
    // Then no generation or child ownership survives.
    eq(await entries(`${f.store.directory}/aot/staging`), []);
    eq(await entries(`${f.store.directory}/aot/generations`), []);
    assertIdle(f.resources);
  });
}

Deno.test("native source digest binds the exact buffer passed to precompile", async () => {
  // Given a stage already bound to the reviewed component bytes.
  await using f = await preparationFixture({ component: "sync", tools: [] });
  const snapshot = f.store.snapshot(f.reviewed);
  // When host-owned fault injection changes same-size source after lease acquisition.
  await rejects(
    f.coordinator.prepare(f.reviewed, {
      operationId: "changed-source",
      signal: timeout(),
      async observe(event) {
        if (event.phase !== "locked") return;
        const path = `${snapshot.package.root}/entry.wasm`;
        const bytes = preparationBytes("sync");
        bytes[bytes.length - 1] ^= 1;
        await Deno.chmod(path, 0o600);
        await Deno.writeFile(path, bytes);
      },
    }),
    /Source digest mismatch/,
  );
  // Then the native has not compiled or published the substituted source.
  eq(await entries(`${f.store.directory}/aot/staging`), []);
  eq(await entries(`${f.store.directory}/aot/generations`), []);
  assertIdle(f.resources);
});

Deno.test("cooperative stdin must be explicitly declared", async () => {
  // Given a valid cooperative core module declared as blocking.
  await using f = await preparationFixture({
    tools: [{ id: "engine", source: "cooperative" }],
  });
  // When precompiling, without invocation.
  await rejects(
    f.coordinator.prepare(f.reviewed, {
      operationId: "stdin",
      signal: timeout(),
    }),
    /Undeclared cooperative/,
  );
  // Then the incompatible preparation cannot be installed.
  assertIdle(f.resources);
  eq(await entries(`${f.store.directory}/aot/staging`), []);
});

Deno.test("native preparation never recreates a missing stage", async () => {
  // Given no staging directory or lock exists.
  await using f = await preparationFixture();
  const processes = new PreparationProcesses(executable, f.resources);
  const path = `${f.base}/absent-stage`;
  // When invoking the actual mode under parent-owned admission.
  await rejects(
    processes.run({
      attribution: {
        moduleId: "test.preparation",
        generationId: "missing",
        operationId: "missing",
      },
      args: ["--aot-prepare", path],
      signal: timeout(),
      receive() {
        throw new Error("Missing stage must never acknowledge ownership");
      },
    }),
    /Native preparation failed/,
  );
  // Then native has neither invented ownership nor created storage.
  await rejects(Deno.stat(path), Deno.errors.NotFound);
  assertIdle(f.resources);
});

// These legacy execution witnesses migrate to prepared load modes in tasks 5/6.
// They are not a source-execution fallback in the preparation coordinator.
const unreachableTrap = /wasm trap: wasm `unreachable` instruction executed/;

async function preparedComponentExecution(
  f: Awaited<ReturnType<typeof preparationFixture>>,
  operationId: string,
) {
  const prepared = await f.coordinator.prepare(f.reviewed, {
    operationId: `prepare-${operationId}`,
    signal: timeout(),
  });
  const pin = await f.store.pin(prepared);
  const target = pin.descriptor?.targets.find((item) =>
    item.kind === "component-entry"
  );
  ok(pin.directory && prepared.artifactSetId && target);
  const lease = await f.resources.acquireLoad({
    moduleId: "test.witness",
    generationId: prepared.artifactSetId,
    operationId,
    kind: "wasm-standard",
    artifactBytes: target.artifact.size,
  }, timeout());
  return {
    args: [
      "--component-aot",
      pin.directory,
      prepared.artifactSetId,
      pin.snapshot.package.manifest.wasmProfile ?? "async",
    ],
    lease,
    pin,
  };
}

for (const component of ["sync", "async"] as const) {
  Deno.test(`guest trap witness: ${component} really fails on load or activation`, async () => {
    // Given the exact binary that preparation accepts without executing.
    await using f = await preparationFixture({ component, tools: [] });
    const execution = await preparedComponentExecution(
      f,
      `${component}-witness`,
    );
    const child = new ModuleProcess(
      new Deno.Command(executable, {
        args: execution.args,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
        clearEnv: true,
        env: { MAGHEMITE_LOAD_NOTIFY: "1" },
      }),
    );
    execution.lease.attach(child.pid);
    try {
      await child.loaded.wait(timeout());
      execution.lease.loaded();
      // When the prepared-only surface actually activates it.
      await rejects(
        child.call("activate", { input: null }, () => {
          throw new Error("No host import should execute");
        }, timeout()),
        (error: unknown) => {
          ok(error instanceof Error);
          console.log(
            JSON.stringify({
              witness: `${component}-activation`,
              diagnostic: error.message,
            }),
          );
          return unreachableTrap.test(error.message);
        },
      );
      // Then the trap is live, not a harmless fixture claiming non-execution.
    } finally {
      await child.close();
      execution.lease.release();
      execution.pin.release();
    }
    assertIdle(f.resources);
  });
}

Deno.test("guest trap witness: core start has drained native trap evidence", async () => {
  // Given the same component whose core start preparation must never invoke.
  await using f = await preparationFixture({ component: "start", tools: [] });
  const execution = await preparedComponentExecution(
    f,
    "core-start-witness",
  );
  const child = new Deno.Command(executable, {
    args: execution.args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    clearEnv: true,
    env: { MAGHEMITE_LOAD_NOTIFY: "1" },
  }).spawn();
  execution.lease.attach(child.pid);
  try {
    // When real instantiation calls the core start, capture status AND both drains.
    const result = await child.output();
    const diagnostic = new TextDecoder().decode(result.stderr);
    console.log(
      JSON.stringify({
        witness: "core-start",
        exitCode: result.code,
        diagnostic,
      }),
    );
    // Then only an actual Wasmtime unreachable trap satisfies this witness.
    equal(result.code, 1);
    ok(unreachableTrap.test(diagnostic), diagnostic);
  } finally {
    execution.lease.release();
    execution.pin.release();
  }
  assertIdle(f.resources);
});

Deno.test("guest trap witness: actual WASI _start traps", async () => {
  await verifyPreparedWasiTrap();
});
