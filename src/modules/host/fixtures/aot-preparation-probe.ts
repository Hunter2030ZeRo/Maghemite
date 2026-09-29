/** Real CLI/API evidence. All sources, stage leases and processes are owned here. */
import { deepStrictEqual as eq, equal, rejects } from "node:assert/strict";
import { RESOURCE_DEFAULTS } from "../resources.ts";
import {
  assertCanonical, assertIdle, barrier, bounded, entries, preparationFixture, timeout,
} from "./aot-preparation-support.ts";

let root = "";
{
  await using f = await preparationFixture({
    component: "start",
    tools: [{ id: "first", source: "tool" }, { id: "second", source: "tool" }],
  });
  root = f.base;
  const info = await f.coordinator.info({
    moduleId: "test.preparation", generationId: f.reviewed.slot, operationId: "probe-info",
  }, timeout());
  equal(info.size, 4);
  console.log(JSON.stringify({ action: "native-info", producers: [...info] }));
  const prepared = await f.coordinator.prepare(f.reviewed, {
    operationId: "probe-complete", signal: timeout(),
    observe: (event) => console.log(JSON.stringify({ action: "native-progress", ...event })),
  });
  const descriptor = await assertCanonical(f, prepared);
  eq(descriptor.targets.map((t) => [t.toolId, t.sourcePath, t.artifact.file]), [
    [null, "entry.wasm", "component.cwasm"],
    ["first", "tool.wasm", "tool-0.cwasm"],
    ["second", "tool.wasm", "tool-1.cwasm"],
  ]);
  assertIdle(f.resources);
  console.log(JSON.stringify({
    action: "published", artifactSetId: prepared.artifactSetId, descriptor,
    noGuestExecution: "trapping component core start and WASI _start were not invoked",
    resources: f.resources.inspect(),
  }));

  const held = barrier("ready");
  const abort = new AbortController();
  const attempt = f.coordinator.prepare(f.reviewed, {
    operationId: "probe-cancel", signal: abort.signal, observe: held.observe,
  });
  const rejected = rejects(attempt, { name: "AbortError" });
  try {
    const ready = await bounded(held.entered);
    equal(f.resources.inspect().compilation.active, 1);
    equal(f.resources.inspect().reservedBytes, RESOURCE_DEFAULTS.wasmStartupBytes);
    equal(f.resources.inspect().processes[0]?.pid, ready.pid);
    console.log(JSON.stringify({ action: "ready-still-owned", ready, resources: f.resources.inspect() }));
    abort.abort();
    await rejected;
    held.release(); // Even a late callback cannot publish this cancelled stage.
    assertIdle(f.resources);
    eq(await entries(`${f.store.directory}/aot/staging`), []);
    eq(await entries(`${f.store.directory}/aot/generations/${f.reviewed.slot}`), [prepared.artifactSetId]);
    const pin = await f.store.pin(prepared);
    pin.release();
    console.log(JSON.stringify({ action: "cancelled-and-drained", preserved: prepared.artifactSetId, resources: f.resources.inspect() }));
  } finally {
    abort.abort();
    held.release();
    await rejected;
  }
  await f.store.reclaim(prepared);
  await f.store.discardReviewed(f.reviewed);
}
console.log(JSON.stringify({
  action: "cleanup", removed: root,
  receipt: "all child statuses and stdout/stderr drains awaited; reservations zero; store lock closed; temp root removed",
}));
