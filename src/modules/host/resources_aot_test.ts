import { deepStrictEqual as eq, rejects } from "node:assert/strict";
import { RESOURCE_DEFAULTS, ResourceAdmission } from "./resources.ts";

const MiB = 1048576;
const signal = () => AbortSignal.timeout(5000);

function changed(
  resources: ResourceAdmission,
  predicate: () => boolean,
): Promise<void> {
  const timeout = AbortSignal.timeout(5000);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      resources.removeEventListener("change", check);
      timeout.removeEventListener("abort", abort);
    };
    const check = () => {
      if (!predicate()) return;
      cleanup();
      resolve();
    };
    const abort = () => {
      cleanup();
      reject(timeout.reason);
    };
    resources.addEventListener("change", check);
    timeout.addEventListener("abort", abort, { once: true });
    check();
  });
}

Deno.test("preparation completion marker does not release admission", async () => {
  // Given: one active preparation and two queued operations.
  const resources = new ResourceAdmission({ coreRss: () => 0 });
  const first = await resources.acquirePreparation({
    moduleId: "test.preparation",
    generationId: "generation-a",
    operationId: "operation-a",
  }, signal());
  first.attach(101);
  const secondQueued = changed(
    resources,
    () => resources.inspect().compilation.queued === 1,
  );
  const secondPending = resources.acquirePreparation({
    moduleId: "test.preparation",
    generationId: "generation-b",
    operationId: "operation-b",
  }, signal());
  await secondQueued;
  const cancelledQueued = changed(
    resources,
    () => resources.inspect().compilation.queued === 2,
  );
  const cancellation = new AbortController();
  const cancelledPending = resources.acquirePreparation({
    moduleId: "test.cancelled",
    generationId: "generation-c",
    operationId: "operation-c",
  }, cancellation.signal);
  await cancelledQueued;

  // When: the producer reports ready and a separate queued operation is aborted twice.
  const producer = new EventTarget();
  const ready = new Promise<void>((resolve) =>
    producer.addEventListener("ready", () => resolve(), { once: true })
  );
  producer.dispatchEvent(new Event("ready"));
  await ready;
  const cancelled = rejects(cancelledPending, { name: "AbortError" });
  cancellation.abort();
  cancellation.abort();
  await cancelled;

  // Then: A still owns its full reservation/permit and B remains queued.
  const held = resources.inspect();
  eq(held.compilation, { active: 1, limit: 1, queued: 1 });
  eq(held.reservedBytes, RESOURCE_DEFAULTS.wasmStartupBytes);
  eq(held.processes.length, 1);
  const heldProcess = held.processes[0];
  if (!heldProcess) throw new TypeError("Expected active preparation");
  eq({
    moduleId: heldProcess.moduleId,
    kind: heldProcess.kind,
    operation: heldProcess.operation,
    operationId: heldProcess.operationId,
    generationId: heldProcess.generationId,
    compilerPermit: heldProcess.compilerPermit,
    worker: heldProcess.worker,
    phase: heldProcess.phase,
    pid: heldProcess.pid,
    reservedBytes: heldProcess.reservedBytes,
    rssBytes: heldProcess.rssBytes,
  }, {
    moduleId: "test.preparation",
    kind: "aot-preparation",
    operation: "preparation",
    operationId: "operation-a",
    generationId: "generation-a",
    compilerPermit: true,
    worker: false,
    phase: "preparing",
    pid: 101,
    reservedBytes: RESOURCE_DEFAULTS.wasmStartupBytes,
    rssBytes: null,
  });

  // When: the owner observes A's exit and releases its lease.
  const secondAdmitted = changed(
    resources,
    () =>
      resources.inspect().processes.some((process) =>
        process.operationId === "operation-b"
      ),
  );
  first.release();
  await secondAdmitted;
  const second = await secondPending;

  // Then: B receives the sole permit; stale/repeated A transitions do nothing.
  first.attach(999);
  first.release();
  eq(resources.inspect().compilation, { active: 1, limit: 1, queued: 0 });
  eq(resources.inspect().processes.map((process) => process.operationId), [
    "operation-b",
  ]);
  second.release();
  second.release();
  eq(resources.inspect().processes, []);
});

Deno.test("AOT load admission has no compiler permit", async () => {
  // Given: an existing host reservation and an artifact load.
  const resources = new ResourceAdmission({ coreRss: () => 0 });
  const terminal = await resources.reserveHostUsage({
    id: "terminal:load-test",
    label: "Owned terminal",
    rssBytes: null,
    reservedBytes: 64 * MiB,
    diskBytes: null,
  }, signal());
  const artifactBytes = 7 * MiB;
  const load = await resources.acquireLoad({
    moduleId: "test.load",
    generationId: "generation-load",
    operationId: "operation-load",
    kind: "wasm-standard",
    artifactBytes,
  }, signal());
  load.attach(202);

  // When: deserialization is still retaining the owned artifact buffer.
  const loading = resources.inspect();

  // Then: transient and retained bytes are reserved without a compiler permit.
  eq(loading.compilation, { active: 0, limit: 1, queued: 0 });
  eq(
    loading.reservedBytes,
    64 * MiB + 128 * MiB + 2 * artifactBytes,
  );
  const loadingProcess = loading.processes[0];
  if (!loadingProcess) throw new TypeError("Expected active artifact load");
  eq({
    moduleId: loadingProcess.moduleId,
    kind: loadingProcess.kind,
    operation: loadingProcess.operation,
    operationId: loadingProcess.operationId,
    generationId: loadingProcess.generationId,
    compilerPermit: loadingProcess.compilerPermit,
    worker: loadingProcess.worker,
    phase: loadingProcess.phase,
    pid: loadingProcess.pid,
    reservedBytes: loadingProcess.reservedBytes,
    rssBytes: loadingProcess.rssBytes,
  }, {
    moduleId: "test.load",
    kind: "wasm-standard",
    operation: "artifact-load",
    operationId: "operation-load",
    generationId: "generation-load",
    compilerPermit: false,
    worker: false,
    phase: "loading",
    pid: 202,
    reservedBytes: 128 * MiB + 2 * artifactBytes,
    rssBytes: null,
  });

  // When: verified deserialization releases the transient buffers.
  load.loaded();
  load.loaded();

  // Then: only retained runtime and unchanged host reservations remain.
  const loaded = resources.inspect();
  eq(loaded.compilation.active, 0);
  eq(loaded.reservedBytes, 64 * MiB + 128 * MiB);
  eq(loaded.processes[0]?.phase, "running");
  eq(loaded.processes[0]?.reservedBytes, 128 * MiB);
  load.release();
  load.loaded();
  load.attach(999);
  load.release();
  terminal.release();
  eq(resources.inspect().reservedBytes, 0);
});

Deno.test("AOT acquisition rejects malformed attribution and byte lengths", async () => {
  const resources = new ResourceAdmission({ coreRss: () => 0 });
  await rejects(
    resources.acquirePreparation({
      moduleId: "test.invalid",
      generationId: "",
      operationId: "operation-invalid",
    }, signal()),
    /attribution/,
  );
  await rejects(
    resources.acquireLoad({
      moduleId: "test.invalid",
      generationId: "generation-invalid",
      operationId: "operation-invalid",
      kind: "wasi-tool",
      artifactBytes: Math.floor(Number.MAX_SAFE_INTEGER / 2),
    }, signal()),
    /byte length/,
  );
  eq(resources.inspect().queued, 0);
  eq(resources.inspect().processes, []);
});
