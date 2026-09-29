import { deepStrictEqual as eq, ok, rejects } from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_METHODS, createAppAPI } from "../../../modules-sdk/js/app.ts";
import type { ApplicationCaller } from "../../modules/host/application.ts";
import { applicationRequest } from "../../modules/host/application.ts";
import { ResourceAdmission } from "../../modules/host/resources.ts";
import { NativeApplicationServices } from "./application.ts";
import { EventHub } from "./events.ts";
import { ProtocolSession, ToolSession } from "./processes.ts";

const fixture = fileURLToPath(new URL("./process_fixture.ts", import.meta.url));
const coreLibrary = fileURLToPath(
  new URL("../../../native/target/release/libmaghemite_core.so", import.meta.url),
);

function change(resources: ResourceAdmission, predicate: () => boolean) {
  const signal = AbortSignal.timeout(5_000);
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      resources.removeEventListener("change", check);
      signal.removeEventListener("abort", aborted);
    };
    const check = () => {
      if (!predicate()) return;
      cleanup();
      resolve();
    };
    const aborted = () => {
      cleanup();
      reject(signal.reason);
    };
    resources.addEventListener("change", check);
    signal.addEventListener("abort", aborted, { once: true });
    check();
  });
}

Deno.test("quiet tool completion emits an observable lifecycle event", async () => {
  const hub = new EventHub();
  const caller: ApplicationCaller = {
    moduleId: "test.processes",
    owner: "test-owner",
    grants: new Set(["tools.run"]),
    signal: AbortSignal.timeout(5_000),
  };
  const subscription = hub.subscribe(["tools.output"], caller);
  const completion = hub.next(subscription.subscription, 5_000, caller);

  const session = new ToolSession(
    caller.owner ?? caller.moduleId,
    { id: "quiet", kind: "tool", command: "/bin/true" },
    Deno.cwd(),
    "",
    hub,
  );
  try {
    const observed = await completion;
    eq(observed.events, [{
      sequence: 1,
      topic: "tools.output",
      data: { session: session.id },
    }]);
    eq(session.read().done, true);
    eq(session.read().exitCode, 0);
  } finally {
    await session.close();
  }
});

Deno.test("tool result distinguishes complete and truncated output", async () => {
  const complete = new ToolSession(
    "test-owner",
    { id: "quiet", kind: "tool", command: "/bin/true" },
    Deno.cwd(),
    "",
    new EventHub(),
  );
  eq(await complete.result(AbortSignal.timeout(5_000)), {
    stdout: "",
    stderr: "",
    exitCode: 0,
    cancelled: false,
    complete: true,
    truncated: { stdout: false, stderr: false },
  });

  const truncated = new ToolSession(
    "test-owner",
    {
      id: "large",
      kind: "tool",
      command: Deno.execPath(),
      args: ["run", fixture, "large"],
    },
    Deno.cwd(),
    "",
    new EventHub(),
  );
  const result = await truncated.result(AbortSignal.timeout(5_000));
  eq(result.complete, false);
  eq(result.truncated, { stdout: true, stderr: false });
  eq(result.stdout.length, 32_768);
  await Promise.all([complete.close(), truncated.close()]);
});

Deno.test("quiet protocol exit reports completion and releases its reservation", async () => {
  const hub = new EventHub();
  const caller: ApplicationCaller = {
    moduleId: "test.processes",
    owner: "test-owner",
    grants: new Set(["debug.use"]),
    signal: AbortSignal.timeout(5_000),
  };
  const subscription = hub.subscribe(["debug.message"], caller);
  const completion = hub.next(subscription.subscription, 5_000, caller);
  let pid: number | undefined;
  let releases = 0;
  const session = new ProtocolSession(
    caller.owner ?? caller.moduleId,
    { id: "quiet-debug", kind: "debug", command: "/bin/true" },
    Deno.cwd(),
    hub,
    {
      started: (child) => pid = child,
      release: () => releases++,
    },
  );
  const observed = await completion;
  ok(pid);
  eq(observed.events[0]?.data, { session: session.id, closed: true });
  eq(session.read().closed, true);
  eq(session.read().exitCode, 0);
  eq(releases, 1);
  await session.close();
  eq(releases, 1);
});

Deno.test("configured tools reserve, report, cancel and release owned processes", async () => {
  const temporary = await Deno.makeTempDir({
    prefix: "maghemite-process-lifecycle-",
  });
  const root = join(temporary, "workspace");
  const marker = join(temporary, "spawned");
  await Deno.mkdir(root);
  const MiB = 1024 * 1024;
  const resources = new ResourceAdmission({
    budgetBytes: 1024 * MiB,
    coreRss: () => 0,
    processRss: () => Promise.resolve(null),
    ownedProcesses: () =>
      Promise.resolve({
        source: "unavailable",
        complete: false,
        processes: [],
      }),
  });
  const service = await NativeApplicationServices.open({
    root,
    dataDirectory: join(temporary, "data"),
    coreLibrary,
    resources,
    profiles: [
      {
        id: "quiet",
        kind: "tool",
        command: Deno.execPath(),
        args: ["run", fixture, "quiet"],
      },
      {
        id: "wait",
        kind: "tool",
        command: Deno.execPath(),
        args: ["run", fixture, "wait"],
      },
      {
        id: "mark",
        kind: "tool",
        command: Deno.execPath(),
        args: ["run", "--allow-write", fixture, "mark", marker],
      },
    ],
  });
  const grants = new Set([...Object.values(APP_METHODS), "process.execute"]);
  const caller: ApplicationCaller = {
    moduleId: "test.processes",
    owner: "test-owner",
    grants,
    signal: AbortSignal.timeout(30_000),
  };
  const api = createAppAPI((method, parameters) =>
    applicationRequest(
      service,
      caller.moduleId,
      grants,
      { method, parameters },
      caller.signal,
      caller.owner,
    )
  );
  const other = createAppAPI((method, parameters) =>
    applicationRequest(
      service,
      caller.moduleId,
      grants,
      { method, parameters },
      caller.signal,
      "other-owner",
    )
  );
  try {
    const subscription = await api.events.subscribe({
      topics: ["tools.output"],
    });
    const completed = api.events.next({
      subscription: subscription.subscription,
      waitMs: 5_000,
    });
    const quiet = await api.tools.start({ profile: "quiet" });
    const event = await completed;
    eq(event.events[0]?.data, { session: quiet.session });
    eq((await api.tools.result({ session: quiet.session })).complete, true);
    eq(resources.inspect().external, []);

    const waiting = await api.tools.start({ profile: "wait" });
    const usage = resources.inspect().external;
    eq(usage.length, 1);
    ok(usage[0]?.pid);
    await rejects(
      () => other.tools.cancel({ session: waiting.session }),
      /owned/,
    );
    await api.tools.cancel({ session: waiting.session });
    const cancelled = await api.tools.result({ session: waiting.session });
    eq(cancelled.cancelled, true);
    eq(cancelled.complete, true);
    eq(resources.inspect().external, []);

    const blocker = await resources.reserveHostUsage({
      id: "test.blocker",
      label: "Test blocker",
      pid: null,
      rssBytes: null,
      reservedBytes: 1024 * MiB,
      diskBytes: null,
    }, AbortSignal.timeout(5_000));
    const queued = api.tools.start({ profile: "mark" });
    await change(resources, () => resources.inspect().queued === 1);
    const rejected = rejects(queued, { name: "AbortError" });
    await service.release("test-owner");
    await rejected;
    blocker.release();
    await rejects(() => Deno.stat(marker), Deno.errors.NotFound);
    eq(resources.inspect().external, []);
    eq(resources.inspect().queued, 0);
  } finally {
    await service.close();
    await Deno.remove(temporary, { recursive: true });
  }
});
