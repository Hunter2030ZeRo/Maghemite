import { deepStrictEqual as eq, ok, rejects, throws } from "node:assert/strict";
import "./resources_aot_test.ts";
import { ResourceAdmission } from "./resources.ts";
import {
  COMPILATION_COMPLETE,
  CompilationSignal,
} from "../runtimes/compilation.ts";

const MiB = 1048576;
const signal = () => AbortSignal.timeout(5000);

Deno.test("application admission serializes compilation FIFO and removes cancellation immediately", async () => {
  const resources = new ResourceAdmission({ coreRss: () => 96 * MiB });
  const first = await resources.acquire({
    moduleId: "test.one",
    kind: "wasm-standard",
  }, signal());
  const cancel = new AbortController();
  const queued = resources.acquire({
    moduleId: "test.cancel",
    kind: "wasi-tool",
  }, cancel.signal);
  const cancelled = rejects(queued, { name: "AbortError" });
  const next = resources.acquire({
    moduleId: "test.next",
    kind: "wasm-compute",
    worker: true,
  }, signal());
  eq(resources.inspect().compilation, { active: 1, limit: 1, queued: 2 });
  cancel.abort();
  await cancelled;
  eq(resources.inspect().queued, 1);
  first.compiled();
  const second = await next;
  eq(resources.inspect().processes.map((p) => [p.moduleId, p.phase]), [
    ["test.one", "running"],
    ["test.next", "starting"],
  ]);
  first.release();
  second.release();
  second.release();
  eq(resources.inspect().reservedBytes, 0);
  eq(resources.inspect().compilation.active, 0);
});

Deno.test("default headroom admits a second large language while the first stays resident", async () => {
  const resources = new ResourceAdmission({
    coreRss: () => 96 * MiB,
    processRss: () => Promise.resolve(350 * MiB),
  });
  const adapters = await Promise.all(
    ["test.one", "test.two"].map((moduleId) =>
      resources.acquire({ moduleId, kind: "deno" }, signal())
    ),
  );
  const first = await resources.acquire({
    moduleId: "test.one",
    kind: "wasi-tool",
  }, signal());
  first.attach(101);
  first.compiled();
  const second = await resources.acquire({
    moduleId: "test.two",
    kind: "wasi-tool",
  }, signal());
  const snapshot = await resources.snapshot();
  eq(
    snapshot.processes.filter((p) => p.kind === "wasi-tool").map((p) =>
      p.phase
    ),
    ["running", "starting"],
  );
  ok(snapshot.chargedBytes <= snapshot.budgetBytes);
  eq(snapshot.compilation.active, 1);
  first.release();
  second.release();
  for (const adapter of adapters) adapter.release();
});

Deno.test("observed RSS and host reservations share admission without inventing missing metrics", async () => {
  const resources = new ResourceAdmission({
    budgetBytes: 512 * MiB,
    coreRss: () => 64 * MiB,
    processRss: () => Promise.resolve(null),
  });
  const terminal = await resources.reserveHostUsage({
    id: "terminal:1",
    label: "Owned terminal",
    rssBytes: null,
    reservedBytes: 384 * MiB,
    diskBytes: null,
  }, signal());
  const pending = resources.acquire(
    { moduleId: "test.waiting", kind: "deno" },
    signal(),
  );
  eq(resources.inspect().queued, 1);
  eq(resources.inspect().external[0].rssBytes, null);
  terminal.release();
  const guest = await pending;
  guest.attach(123);
  const snapshot = await resources.snapshot();
  eq(snapshot.observedModuleRssBytes, null);
  eq(snapshot.chargedBytes, 192 * MiB);
  resources.reportHostUsage({
    id: "cef:1",
    label: "Owned CEF renderer",
    rssBytes: 400 * MiB,
    reservedBytes: 64 * MiB,
    diskBytes: null,
  });
  eq(resources.inspect().chargedBytes, 592 * MiB);
  const cancel = new AbortController();
  const blocked = resources.reserveHostUsage({
    id: "cache:1",
    label: "Cache",
    rssBytes: null,
    reservedBytes: MiB,
    diskBytes: 16 * MiB,
  }, cancel.signal);
  const cancelled = rejects(blocked, { name: "AbortError" });
  cancel.abort();
  await cancelled;
  eq(resources.inspect().external.map((p) => p.id), ["cef:1"]);
  resources.releaseHostUsage("cef:1");
  guest.release();
});

Deno.test("queue overflow and oversized requests fail without retaining reservations", async () => {
  const resources = new ResourceAdmission({
    budgetBytes: 256 * MiB,
    coreRss: () => 0,
    queueLimit: 1,
  });
  const first = await resources.acquire(
    { moduleId: "test.one", kind: "deno" },
    signal(),
  );
  const second = await resources.acquire(
    { moduleId: "test.two", kind: "deno" },
    signal(),
  );
  const cancel = new AbortController();
  const waiting = resources.acquire(
    { moduleId: "test.wait", kind: "deno" },
    cancel.signal,
  );
  const cancelled = rejects(waiting);
  await rejects(
    resources.acquire({ moduleId: "test.full", kind: "deno" }, signal()),
    /queue is full/,
  );
  await rejects(
    resources.acquire({ moduleId: "test.large", kind: "wasi-tool" }, signal()),
    /exceeds/,
  );
  cancel.abort();
  await cancelled;
  first.release();
  second.release();
  eq(resources.inspect().processes, []);
  eq(resources.inspect().queued, 0);
});

Deno.test("native compilation notification survives split pipe chunks and cancellation", async () => {
  const ready = new CompilationSignal();
  const waiting = ready.wait(signal());
  const bytes = new TextEncoder().encode(COMPILATION_COMPLETE);
  ready.consume(bytes.subarray(0, 7));
  ready.consume(bytes.subarray(7));
  await waiting;
  const failed = new CompilationSignal();
  const cancel = new AbortController();
  const result = failed.wait(cancel.signal);
  const cancelled = rejects(result, { name: "AbortError" });
  cancel.abort();
  await cancelled;
});

Deno.test("cancellation at dispatch returns a reservation before the caller can spawn", async () => {
  const resources = new ResourceAdmission({ coreRss: () => 0 });
  const cancel = new AbortController();
  resources.addEventListener("change", () => {
    if (resources.inspect().processes.length) cancel.abort();
  });
  await rejects(
    resources.acquire({ moduleId: "test.cancel", kind: "deno" }, cancel.signal),
    { name: "AbortError" },
  );
  eq(resources.inspect().processes, []);
});

Deno.test("owned tree charges CEF and terminal children without double-counting tracked guest PIDs", async () => {
  const resources = new ResourceAdmission({
    coreRss: () => 64 * MiB,
    ownedProcesses: () =>
      Promise.resolve({
        source: "linux-proc",
        complete: true,
        processes: [{ pid: 101, rssBytes: 180 * MiB }, {
          pid: 202,
          rssBytes: 300 * MiB,
        }],
      }),
    processRss: () => {
      throw new Error("Known tree PID must not be sampled twice");
    },
  });
  const guest = await resources.acquire({
    moduleId: "test.guest",
    kind: "deno",
  }, signal());
  guest.attach(101);
  resources.reportHostUsage({
    id: "renderer.attachments",
    label: "Attachments",
    pid: 202,
    rssBytes: null,
    reservedBytes: 64 * MiB,
    diskBytes: null,
  });
  resources.reportRendererAttachments(20 * MiB, 64 * MiB);
  const snapshot = await resources.snapshot();
  eq(snapshot.ownedTree.rssBytes, 544 * MiB);
  eq(snapshot.observedModuleRssBytes, 180 * MiB);
  eq(snapshot.chargedBytes, 544 * MiB);
  eq(snapshot.external[0].retainedBytes, 20 * MiB);
  eq(snapshot.external[0].rssBytes, null);
  throws(
    () => resources.reportRendererAttachments(65 * MiB, 64 * MiB),
    /Invalid/,
  );
  guest.release();
  resources.releaseHostUsage("renderer.attachments");
});

Deno.test("partial process tree preserves unknown totals and charges known children plus reservations", async () => {
  const resources = new ResourceAdmission({
    coreRss: () => 64 * MiB,
    ownedProcesses: () =>
      Promise.resolve({
        source: "linux-proc",
        complete: false,
        processes: [{ pid: 101, rssBytes: null }, {
          pid: 202,
          rssBytes: 32 * MiB,
        }],
      }),
  });
  const guest = await resources.acquire({
    moduleId: "test.guest",
    kind: "deno",
  }, signal());
  guest.attach(101);
  const snapshot = await resources.snapshot();
  eq(snapshot.ownedTree.rssBytes, null);
  eq(snapshot.ownedTree.knownRssBytes, 96 * MiB);
  eq(snapshot.observedModuleRssBytes, null);
  eq(snapshot.chargedBytes, 224 * MiB);
  guest.release();
});

Deno.test("attachment reservations follow one owned CEF renderer and clear stale associations", async () => {
  let processes: { pid: number; rssBytes: number; role: "cef-renderer" }[] = [
    { pid: 202, rssBytes: 300 * MiB, role: "cef-renderer" },
  ];
  const resources = new ResourceAdmission({
    coreRss: () => 64 * MiB,
    ownedProcesses: () => Promise.resolve({ source: "linux-proc", complete: true, processes }),
  });
  resources.reportRendererAttachments(20 * MiB, 64 * MiB);
  const associated = await resources.snapshot();
  eq(associated.external[0].pid, 202);
  eq(associated.external[0].rssBytes, null);
  eq(associated.chargedBytes, 364 * MiB);
  processes = [];
  const detached = await resources.snapshot();
  eq(detached.external[0].pid, null);
  eq(detached.chargedBytes, 128 * MiB);
  resources.releaseHostUsage("renderer.attachments");
});
