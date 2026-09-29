import { deepStrictEqual as eq } from "node:assert/strict";
import { RESOURCE_DEFAULTS, ResourceAdmission } from "../resources.ts";
import {
  type BarrierChild,
  bounded,
  changed,
  cleanupChild,
  type Outcome,
  outcome,
  parseFault,
  ready,
  type Releasable,
  spawnBarrierChild,
  stopChild,
  WAIT_TIMEOUT_MS,
} from "./aot-resources-probe-support.ts";

const MiB = 1048576;

function observe(label: string, resources: ResourceAdmission): void {
  const snapshot = resources.inspect();
  console.log(JSON.stringify({
    label,
    compilation: snapshot.compilation,
    queued: snapshot.queued,
    reservedBytes: snapshot.reservedBytes,
    processes: snapshot.processes.map((process) => ({
      moduleId: process.moduleId,
      operation: process.operation,
      operationId: process.operationId,
      generationId: process.generationId,
      compilerPermit: process.compilerPermit,
      phase: process.phase,
      pid: process.pid,
      reservedBytes: process.reservedBytes,
    })),
  }));
}

async function run(): Promise<void> {
  const fault = parseFault(
    Deno.env.get("MAGHEMITE_AOT_RESOURCES_PROBE_FAULT"),
  );
  const resources = new ResourceAdmission({ coreRss: () => 0 });
  const leases = new Set<Releasable>();
  const children: BarrierChild[] = [];
  const controllers: AbortController[] = [];
  const pending: Promise<Outcome<Releasable>>[] = [];
  const timeout = () => AbortSignal.timeout(WAIT_TIMEOUT_MS);
  let cleanupFailure: AggregateError | null = null;
  try {
    const preparationA = await resources.acquirePreparation({
      moduleId: "probe.module",
      generationId: "generation-a",
      operationId: "operation-a",
    }, timeout());
    leases.add(preparationA);
    const preparationChild = spawnBarrierChild(fault !== "ready-timeout");
    children.push(preparationChild);
    preparationA.attach(preparationChild.process.pid);
    await ready(preparationChild);
    if (fault === "assert-after-ready") {
      throw new TypeError("Injected assertion failure after readiness");
    }

    const preparationBQueued = changed(
      resources,
      () => resources.inspect().compilation.queued === 1,
    );
    const preparationBAbort = new AbortController();
    controllers.push(preparationBAbort);
    const preparationBPending: Promise<Outcome<Releasable>> = outcome(
      resources.acquirePreparation({
        moduleId: "probe.module",
        generationId: "generation-b",
        operationId: "operation-b",
      }, AbortSignal.any([preparationBAbort.signal, timeout()])),
    );
    pending.push(preparationBPending);
    await preparationBQueued;

    const cancelledQueued = changed(
      resources,
      () => resources.inspect().compilation.queued === 2,
    );
    const cancellation = new AbortController();
    controllers.push(cancellation);
    const cancelledPending: Promise<Outcome<Releasable>> = outcome(
      resources.acquirePreparation({
        moduleId: "probe.cancelled",
        generationId: "generation-c",
        operationId: "operation-c",
      }, cancellation.signal),
    );
    pending.push(cancelledPending);
    await cancelledQueued;
    cancellation.abort();
    cancellation.abort();
    const cancellationResult = await bounded(
      cancelledPending,
      "cancelled preparation",
    );
    if (
      cancellationResult.kind !== "rejected" ||
      !(cancellationResult.reason instanceof DOMException)
    ) throw new TypeError("Expected cancellation DOMException");
    eq(cancellationResult.reason.name, "AbortError");

    observe("preparation-ready-alive", resources);
    eq(resources.inspect().compilation, { active: 1, limit: 1, queued: 1 });
    eq(resources.inspect().reservedBytes, RESOURCE_DEFAULTS.wasmStartupBytes);

    if (fault === "exit-timeout") {
      await bounded(
        preparationChild.process.status,
        `child ${preparationChild.process.pid} injected status`,
      );
    }
    await stopChild(preparationChild);
    preparationA.release();
    const preparationBResult = await bounded(
      preparationBPending,
      "second preparation admission",
    );
    if (preparationBResult.kind === "rejected") {
      throw preparationBResult.reason;
    }
    const preparationB = preparationBResult.value;
    leases.add(preparationB);
    observe("preparation-a-exited-b-active", resources);
    eq(resources.inspect().processes[0]?.operationId, "operation-b");
    eq(resources.inspect().compilation, { active: 1, limit: 1, queued: 0 });
    preparationB.release();

    const artifactBytes = 3 * MiB;
    const load = await resources.acquireLoad({
      moduleId: "probe.module",
      generationId: "generation-a",
      operationId: "operation-load",
      kind: "wasm-standard",
      artifactBytes,
    }, timeout());
    leases.add(load);
    const loadChild = spawnBarrierChild(true);
    children.push(loadChild);
    load.attach(loadChild.process.pid);
    await ready(loadChild);
    observe("artifact-load-buffer-retained", resources);
    eq(resources.inspect().compilation.active, 0);
    eq(
      resources.inspect().reservedBytes,
      128 * MiB + 2 * artifactBytes,
    );

    load.loaded();
    observe("artifact-load-deserialized", resources);
    eq(resources.inspect().compilation.active, 0);
    eq(resources.inspect().reservedBytes, 128 * MiB);

    await stopChild(loadChild);
    load.release();
    load.loaded();
    load.release();
    observe("all-owned-children-exited", resources);
    eq(resources.inspect().processes, []);
    eq(resources.inspect().queued, 0);
    eq(resources.inspect().reservedBytes, 0);
  } finally {
    for (const controller of controllers) controller.abort();
    const cleanupFailures: unknown[] = [];
    for (const operation of pending) {
      const settled = await outcome(bounded(
        operation,
        "pending resource acquisition cleanup",
      ));
      if (settled.kind === "fulfilled") {
        if (settled.value.kind === "fulfilled") {
          leases.add(settled.value.value);
        }
      } else cleanupFailures.push(settled.reason);
    }
    for (const child of children.toReversed()) {
      const cleaned = await outcome(cleanupChild(child));
      if (cleaned.kind === "rejected") cleanupFailures.push(cleaned.reason);
    }
    for (const lease of leases) lease.release();
    const snapshot = resources.inspect();
    console.log(JSON.stringify({
      cleanup: {
        fault,
        childPids: children.map((child) => child.process.pid),
        childrenExited: children.every((child) => child.status !== null),
        inputsClosed: children.every((child) => child.inputClosed),
        outputsCancelled: children.every((child) => child.outputCancelled),
        queued: snapshot.queued,
        active: snapshot.compilation.active,
        reservedBytes: snapshot.reservedBytes,
        processes: snapshot.processes.length,
        errors: cleanupFailures.map((error) => String(error)),
        tempResources: "none-created",
      },
    }));
    if (cleanupFailures.length) {
      cleanupFailure = new AggregateError(
        cleanupFailures,
        "Probe cleanup failed",
      );
    }
  }
  if (cleanupFailure) throw cleanupFailure;
}

await run();
