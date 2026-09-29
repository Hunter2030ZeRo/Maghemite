import { deepStrictEqual as eq, equal, ok, rejects } from "node:assert/strict";
import { PreparationCoordinator } from "../runtimes/preparation.ts";
import { RESOURCE_DEFAULTS } from "./resources.ts";
import "./aot-preparation-lifecycle_test.ts";
import "./aot-preparation-validation_test.ts";
import {
  assertCanonical, assertIdle, barrier, bounded, entries, executable,
  preparationFixture, resourceChange, timeout,
} from "./fixtures/aot-preparation-support.ts";

Deno.test("preparation never executes guests: complete component and all declared tools", async () => {
  // Given a component with a trapping core start and two trapping WASI _start functions.
  await using f = await preparationFixture({ component: "start", tools: [
    { id: "blocking", source: "tool" },
    { id: "cooperative", source: "cooperative", stdin: "cooperative-v1" },
  ] });
  // When the real native coordinator prepares the complete reviewed package.
  const result = await f.coordinator.prepare(f.reviewed, { operationId: "complete", signal: timeout() });
  // Then no start trap occurred, and real canonical objects bind all three targets.
  const descriptor = await assertCanonical(f, result);
  eq(descriptor.targets.map((t) => [t.toolId, t.abi]), [
    [null, "component-sync-v1"], ["blocking", "wasi-p1-blocking-v1"], ["cooperative", "wasi-p1-cooperative-v1"],
  ]);
  assertIdle(f.resources);
});

for (const component of ["async", "sync"] as const) {
  Deno.test(`preparation never executes guests: ${component} lifecycle activation traps remain dormant`, async () => {
    // Given real lifecycle exports which trap on every invocation.
    await using f = await preparationFixture({ component, tools: [] });
    // When preparing, without activation.
    const result = await f.coordinator.prepare(f.reviewed, { operationId: component, signal: timeout() });
    // Then its declared ABI and complete compiler output pass the trusted store.
    const descriptor = await assertCanonical(f, result);
    equal(descriptor.targets[0]?.abi, `component-${component}-v1`);
  });
}

Deno.test("preparation preserves Deno-owned shared-source aliases", async () => {
  // Given two tool identities bound to one source and a throwing Deno entry.
  await using f = await preparationFixture({ tools: [
    { id: "first", source: "tool" }, { id: "second", source: "tool" },
  ] });
  // When preparation enumerates the reviewed declarations.
  const prepared = await f.coordinator.prepare(f.reviewed, { operationId: "aliases", signal: timeout() });
  // Then neither Deno nor _start ran; both aliases have independent output names.
  const descriptor = await assertCanonical(f, prepared);
  eq(descriptor.targets.map((t) => [t.toolId, t.sourcePath, t.artifact.file]), [
    ["first", "tool.wasm", "tool-0.cwasm"], ["second", "tool.wasm", "tool-1.cwasm"],
  ]);
});

for (const theme of [false, true]) {
  Deno.test(`pure ${theme ? "theme" : "Deno"} preparation starts zero native processes`, async () => {
    // Given a source-only package and an impossible native executable.
    await using f = await preparationFixture({ tools: [], theme });
    await f.coordinator.close();
    const c = await PreparationCoordinator.underProfileLock(f.store, { executable: "/absent/native", resources: f.resources });
    try {
      // When preparing via the same public API.
      const prepared = await c.prepare(f.reviewed, { operationId: "pure", signal: timeout() });
      // Then success with no artifact set proves even native metadata was bypassed.
      equal(prepared.artifactSetId, null);
      assertIdle(f.resources);
    } finally { await c.close(); }
  });
}

for (const source of ["badImport", "badStart", "badCooperative", "missingMemory"] as const) {
  Deno.test(`preparation rejects non-executing ABI failure: ${source}`, async () => {
    // Given a structurally valid core module with an unusable import/export ABI.
    await using f = await preparationFixture({ tools: [{
      id: "engine", source,
      ...source === "badCooperative" || source === "missingMemory" ? { stdin: "cooperative-v1" as const } : {},
    }] });
    // When the real linker checks types without instantiation.
    await rejects(f.coordinator.prepare(f.reviewed, { operationId: "bad", signal: timeout() }), /Native preparation failed/);
    // Then no partial set, process or compiler reservation survives.
    eq(await entries(`${f.store.directory}/aot/staging`), []);
    eq(await entries(`${f.store.directory}/aot/generations`), []);
    assertIdle(f.resources);
  });
}

Deno.test("native metadata query has owned preparation admission", async () => {
  // Given an occupied compiler permit.
  await using f = await preparationFixture();
  const held = await f.resources.acquirePreparation({
    moduleId: "test.holder", generationId: "holder", operationId: "holder",
  }, timeout());
  const cancel = new AbortController();
  const queued = resourceChange(f.resources, () => f.resources.inspect().compilation.queued === 1);
  const request = f.coordinator.info({ moduleId: "test.info", generationId: "info", operationId: "info" }, cancel.signal);
  const rejected = rejects(request, { name: "AbortError" });
  try {
    await queued;
    // When cancelling a metadata query in the shared queue.
    cancel.abort();
    await rejected;
    // Then no native PID spawned and the holder keeps its full reservation.
    eq(f.resources.inspect().processes.map((p) => p.pid), [null]);
    equal(f.resources.inspect().reservedBytes, RESOURCE_DEFAULTS.wasmStartupBytes);
  } finally { cancel.abort(); held.release(); }
});

Deno.test("held-ready-before-exit retains permit; abort cannot publish late", async () => {
  // Given the actual compiler has produced output but waits on parent's finish.
  await using f = await preparationFixture();
  const gate = barrier("ready");
  const cancel = new AbortController();
  const first = f.coordinator.prepare(f.reviewed, { operationId: "first", signal: cancel.signal, observe: gate.observe });
  const rejected = rejects(first, { name: "AbortError" });
  const secondCancel = new AbortController();
  try {
    const ready = await bounded(gate.entered);
    const queued = resourceChange(f.resources, () => f.resources.inspect().compilation.queued === 1);
    const second = f.coordinator.prepare(f.reviewed, { operationId: "second", signal: secondCancel.signal });
    const secondRejected = rejects(second, { name: "AbortError" });
    await queued;
    equal(f.resources.inspect().processes[0]?.pid, ready.pid);
    equal(f.resources.inspect().reservedBytes, RESOURCE_DEFAULTS.wasmStartupBytes);
    eq(await entries(`${f.store.directory}/aot/generations`), []);
    // When cancellation kills and awaits A while B is cancelled in its queue.
    secondCancel.abort();
    await secondRejected;
    cancel.abort();
    await rejected;
    gate.release(); // A late host callback cannot grant publication authority.
    // Then actual child/drains, staging and reservations are all gone.
    assertIdle(f.resources);
    eq(await entries(`${f.store.directory}/aot/staging`), []);
    eq(await entries(`${f.store.directory}/aot/generations`), []);
    ok(ready.pid > 0);
  } finally { gate.release(); cancel.abort(); secondCancel.abort(); await rejected; }
});

Deno.test("standalone store ownership rejects competing coordinators", async () => {
  // Given one standalone store lifetime, not a saved PID or registry.
  await using f = await preparationFixture();
  // When a competing coordinator requests the same root.
  await rejects(PreparationCoordinator.open(f.store.directory, { executable, resources: f.resources }), /already owned/);
  // Then release of the actual OS lease permits a fresh owner.
  await f.coordinator.close();
  await using replacement = await PreparationCoordinator.open(f.store.directory, { executable, resources: f.resources });
  equal(replacement.store.directory, f.store.directory);
});

Deno.test("profile and standalone preparation cannot own the same store concurrently", async () => {
  // Given a direct embedder already owns this application-private store.
  await using f = await preparationFixture();
  // When the profile-owned entry point is given the same store.
  let competing: PreparationCoordinator | undefined;
  try {
    await rejects(async () => {
      competing = await PreparationCoordinator.underProfileLock(f.store, { executable, resources: f.resources });
    }, /already owned/);
  } finally {
    await competing?.close();
  }
  // Then the two entry points cannot evade exclusivity by choosing different locks.
  assertIdle(f.resources);
});
