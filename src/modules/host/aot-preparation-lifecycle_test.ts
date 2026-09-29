import { deepStrictEqual as eq, equal, ok, rejects } from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { AotStore } from "./aot.ts";
import { PreparationCoordinator } from "../runtimes/preparation.ts";
import { PreparationProcesses, PreparationTeardownError } from "../runtimes/preparation-process.ts";
import { interrupted } from "../runtimes/preparation-process.ts";
import { AotError } from "../../shared/module_aot.ts";
import { beginDescriptor, producerProtocol } from "../runtimes/preparation-protocol.ts";
import { frame, frames } from "../runtimes/protocol.ts";
import { invariant } from "./aot-schema.ts";
import {
  assertIdle, barrier, bounded, entries, executable, preparationFixture, resourceChange, timeout,
} from "./fixtures/aot-preparation-support.ts";

async function stageFixture(f: Awaited<ReturnType<typeof preparationFixture>>) {
  const snapshot = f.store.snapshot(f.reviewed);
  const info = await f.coordinator.info({
    moduleId: "test.preparation", generationId: f.reviewed.slot, operationId: "staging-info",
  }, timeout());
  const producers = snapshot.targets.map((t) => {
    const p = info.get(t.abi);
    invariant(p, "Missing ABI");
    return p;
  });
  return {
    stage: await f.store.stage(f.reviewed, producers), snapshot,
    descriptor: beginDescriptor(snapshot, producers),
  };
}

for (const cancelWaiting of [false, true]) {
  Deno.test(`occupied stage lease ${cancelWaiting ? "cancels without writes" : "gates native begin"}`, async () => {
    // Given an existing stage locked before the real producer starts.
    await using f = await preparationFixture();
    const { stage, snapshot, descriptor } = await stageFixture(f);
    using owner = await Deno.open(stage.lockPath, { read: true, write: true });
    await owner.lock(true);
    const waiting = Promise.withResolvers<void>();
    const cancel = new AbortController();
    const protocol = producerProtocol(snapshot, descriptor, (event) => {
      if (event.phase === "waiting") waiting.resolve();
    });
    const processes = new PreparationProcesses(executable, f.resources);
    const result = processes.run({
      attribution: { moduleId: "test.preparation", generationId: stage.id, operationId: "occupied" },
      args: ["--aot-prepare", stage.directory], signal: cancel.signal, receive: protocol.receive,
    });
    const outcome = result.then(() => null, (error: unknown) => error);
    try {
      await bounded(waiting.promise);
      eq(await entries(stage.directory), ["owner.lock"]);
      equal(f.resources.inspect().compilation.active, 1);
      // When ownership is released, or cancellation occurs while acquisition is blocked.
      if (cancelWaiting) cancel.abort();
      else await owner.unlock();
      const error = await bounded(outcome);
      if (cancelWaiting) {
        ok(error instanceof DOMException && error.name === "AbortError");
        eq(await entries(stage.directory), ["owner.lock"]);
        await owner.unlock();
        await f.store.discardStage(stage);
      } else {
        equal(error, null);
        protocol.complete();
        await f.store.publish(stage);
      }
      // Then the real producer has exited/drained before its reservation disappears.
      assertIdle(f.resources);
    } finally {
      cancel.abort();
      await owner.unlock();
      await processes.drain();
    }
  });
}

for (const phase of ["locked", "ready"] as const) {
  Deno.test(`parent death ${phase === "locked" ? "before" : "after"} begin is fenced and never adopted`, async () => {
    // Given a real standalone parent owns the sole writer and a real native child.
    await using f = await preparationFixture();
    const directory = `${f.base}/crashed-store`;
    const parent = new Deno.Command(Deno.execPath(), {
      args: ["run", "--quiet", "--allow-read", "--allow-write", "--allow-run", "--allow-env",
        fileURLToPath(new URL("./fixtures/aot-preparation-parent.ts", import.meta.url)),
        directory, f.source, phase, executable],
      stdin: "piped", stdout: "piped", stderr: "piped",
    }).spawn();
    const writer = parent.stdin.getWriter();
    const entered = Promise.withResolvers<Record<string, unknown>>();
    const stdout = (async () => {
      for await (const value of frames(parent.stdout)) entered.resolve(value);
    })();
    const stderr = new Response(parent.stderr).text();
    let exited = false;
    const status = parent.status.then((s) => { exited = true; return s; });
    void status.then(async (s) => {
      if (!s.success) entered.reject(new Error(`Crash parent exited ${s.code}: ${await stderr}`));
    });
    try {
      const held = await bounded(entered.promise);
      invariant(typeof held.pid === "number" && typeof held.generationId === "string", "Missing child attribution");
      eq(held.files, phase === "locked" ? ["owner.lock"] : ["descriptor.json", "owner.lock", "tool-0.cwasm"]);
      // When the parent exits abruptly with the producer held behind the protocol.
      await writer.write(frame({ type: "die" }));
      equal((await bounded(status)).code, 73);
      await stdout;
      const recoveryEvents: number[] = [];
      const observe = () => {
        if (f.resources.inspect().processes.some((p) => p.moduleId === "aot.recovery")) {
          recoveryEvents.push(f.resources.inspect().compilation.active);
        }
      };
      f.resources.addEventListener("change", observe);
      try {
        await using recovered = await bounded(PreparationCoordinator.open(directory, { executable, resources: f.resources }));
        // Then old ownership was acquired under reservation, never by killing a saved PID.
        ok(recoveryEvents.includes(1));
        eq(await recovered.store.orphanStagingIds(), []);
        eq(await entries(`${directory}/aot/generations`), []);
        assertIdle(f.resources);
        // Linux may retain an orphan zombie until init reaps it; it owns no resources.
        if (Deno.build.os === "linux") {
          const observed = await new Deno.Command("ps", {
            args: ["-p", String(held.pid), "-o", "stat="],
            stdout: "piped", stderr: "piped",
          }).output();
          const state = new TextDecoder().decode(observed.stdout).trim();
          ok(observed.code === 0 || observed.code === 1);
          ok(state === "" || state.startsWith("Z"), `Producer still alive: ${state}`);
        }
      } finally { f.resources.removeEventListener("change", observe); }
    } finally {
      if (!exited) parent.kill("SIGKILL");
      await status;
      await Promise.all([stdout, stderr]);
      await writer.close().catch((error: unknown) => {
        if (!(error instanceof Deno.errors.BrokenPipe)) throw error;
      });
      writer.releaseLock();
    }
  });
}

Deno.test("orphan lease waiting retains accounting and blocks competing preparation", async () => {
  // Given an old, unknown-owner stage opened through a different store instance.
  await using f = await preparationFixture();
  const { stage } = await stageFixture(f);
  using owner = await Deno.open(stage.lockPath, { read: true, write: true });
  await owner.lock(true);
  await f.coordinator.close();
  const reopened = await AotStore.open(f.store.directory);
  const entered = resourceChange(f.resources, () => f.resources.inspect().compilation.active === 1);
  const recovering = PreparationCoordinator.underProfileLock(reopened, { executable, resources: f.resources });
  const cancel = new AbortController();
  let recovered: PreparationCoordinator | undefined;
  try {
    await entered;
    const queued = resourceChange(f.resources, () => f.resources.inspect().compilation.queued === 1);
    const processes = new PreparationProcesses(executable, f.resources);
    const info = processes.run({
      attribution: { moduleId: "test.other", generationId: "next", operationId: "next" },
      args: ["--aot-info"], signal: cancel.signal,
      receive: () => Promise.resolve(),
    });
    const rejected = rejects(info, { name: "AbortError" });
    await queued;
    eq(f.resources.inspect().processes.map((p) => [p.moduleId, p.pid]), [["aot.recovery", null]]);
    // When queued compilation is aborted and the old ownership finally drains.
    cancel.abort();
    await rejected;
    await owner.unlock();
    recovered = await bounded(recovering);
    // Then only lease-gated deletion occurred, and unknown RSS was not fabricated.
    eq(await entries(`${f.store.directory}/aot/staging`), []);
    assertIdle(f.resources);
  } finally {
    cancel.abort();
    await owner.unlock();
    recovered ??= await recovering;
    await recovered.close();
  }
});

Deno.test("unexpected native producer death interrupts a held observer without caller cancellation", async () => {
  // Given the real native producer is alive at ready while its host observer waits.
  await using f = await preparationFixture();
  const gate = barrier("ready");
  const cancel = new AbortController();
  const attempt = f.coordinator.prepare(f.reviewed, {
    operationId: "unexpected-death", signal: cancel.signal, observe: gate.observe,
  });
  const outcome = attempt.then(() => null, (error: unknown) => error);
  try {
    const ready = await bounded(gate.entered);
    // When that known live owned child dies, independently of the caller signal.
    Deno.kill(ready.pid, "SIGKILL");
    const error = await interrupted(outcome, AbortSignal.timeout(2000));
    // Then status interrupts the observer; both pipes drain and staging is removed.
    ok(error instanceof AotError);
    equal(cancel.signal.aborted, false);
    assertIdle(f.resources);
    eq(await entries(`${f.store.directory}/aot/staging`), []);
    eq(await entries(`${f.store.directory}/aot/generations`), []);
  } finally {
    cancel.abort();
    gate.release();
    await bounded(outcome);
  }
});

Deno.test("teardown deadline preserves a live producer's leased fixture state", async () => {
  // Given a real native producer held at ready; time is the teardown contract here.
  const f = await preparationFixture();
  const gate = barrier("ready");
  const cancel = new AbortController();
  const outcome = f.coordinator.prepare(f.reviewed, {
    operationId: "retained-teardown", signal: cancel.signal, observe: gate.observe,
  }).then(() => null, (error: unknown) => error);
  try {
    const ready = await bounded(gate.entered);
    // When disposal hits its bounded teardown watchdog, without proof of exit.
    await rejects(f[Symbol.asyncDispose](), PreparationTeardownError);
    // Then neither fixture root nor stage/lock/reservation was prematurely removed.
    equal(f.resources.inspect().processes[0]?.pid, ready.pid);
    equal(f.resources.inspect().compilation.active, 1);
    equal((await entries(`${f.store.directory}/aot/staging`)).length, 1);
    ok((await Deno.stat(f.base)).isDirectory);
  } finally {
    cancel.abort();
    gate.release();
    await bounded(outcome);
    await f[Symbol.asyncDispose]();
  }
});
