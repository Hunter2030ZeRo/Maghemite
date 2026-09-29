import { deepStrictEqual as eq } from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { cp } from "node:fs/promises";
import { startDesktop } from "../../main.ts";
import { nativeExecutable, writePackage } from "../aot-installation-support.ts";
import { InstallationBarriers } from "./barriers.ts";
import { observeNativeProcesses } from "./processes.ts";
import { componentEnvironment } from "../../../modules/host/fixtures/aot-component-support.ts";
import { WorkbenchLanguages } from "../../languages.ts";
import { IdleClock } from "../../../modules/host/fixtures/idle-clock.ts";

/**
 * Owned native desktop QA. Control is a separate loopback endpoint with a
 * one-run secret and no CORS; neither guests nor production RPCs can arm hooks.
 */
export async function serveInstallationFixture() {
  const root = await Deno.makeTempDir({ prefix: "maghemite-aot-ui-" });
  const barriers = new InstallationBarriers();
  const processes = observeNativeProcesses(nativeExecutable);
  const closed = Promise.withResolvers<void>();
  const shutdown = new AbortController();
  let desktop: Awaited<ReturnType<typeof startDesktop>> | undefined;
  let control: ReturnType<typeof Deno.serve> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      barriers.releaseAll();
      shutdown.abort();
      await desktop?.stop();
      await control?.shutdown();
      await processes.close();
      if (desktop) {
        const resources = desktop.modules.resources.inspect();
        eq([resources.processes.length, resources.queued,
          resources.reservedBytes, resources.compilation.active], [0, 0, 0, 0]);
        const lock = await Deno.open(`${root}/profile/desktop.lock`, {
          read: true, write: true,
        });
        try {
          eq(await lock.tryLock(true), true);
          await lock.unlock();
        } finally { lock.close(); }
      }
      Deno.removeSignalListener("SIGINT", signalStop);
      Deno.removeSignalListener("SIGTERM", signalStop);
      await Deno.remove(root, { recursive: true });
      barriers.record("cleaned", { root, desktopPort: desktop?.url,
        controlPort: control?.addr.port, processes: 0, queued: 0, reservedBytes: 0,
        compilerActive: 0, profileLockReleased: true, native: processes.snapshot() });
      closed.resolve();
    })().catch((error) => {
      stopping = undefined;
      closed.reject(error);
      throw error;
    });
    return stopping;
  };
  const signalStop = () => { void stop().catch((error) => console.error(error)); };
  try {
    const workspace = `${root}/workspace`, profile = `${root}/profile`;
    const packages = {
      component: `${root}/packages/component`,
      componentUpdate: `${root}/packages/component-update`,
      tools: `${root}/packages/two-tools`,
      executableTools: `${root}/packages/javascript`,
      workers: `${root}/packages/workers`,
    };
    await Deno.mkdir(workspace);
    await Deno.writeTextFile(`${workspace}/Welcome.md`, "# Native installation QA\n");
    await writePackage(packages.component, 1, "component");
    await writePackage(packages.componentUpdate, 2, "component");
    await writePackage(packages.tools, 1, "tools");
    await cp(fileURLToPath(new URL("../../../../build/modules/javascript/", import.meta.url)),
      packages.executableTools, { recursive: true, force: false, errorOnExist: true });
    {
      await using components = await componentEnvironment();
      await cp(components.worker, packages.workers, { recursive: true });
    }
    const rendererDirectory = `${root}/renderer`;
    await cp(fileURLToPath(new URL("../../../../renderer/dist/", import.meta.url)),
      rendererDirectory, { recursive: true, force: false, errorOnExist: true });
    const launch = async () => {
      const app = await startDesktop([
        "--port=0", `--workspace=${workspace}`, `--data-dir=${profile}`,
      ], {
        wasmExecutable: nativeExecutable, rendererDirectory, installation: barriers.options,
      });
      app.application.moduleManager?.addEventListener("change", () => {
        barriers.record("state", app.application.moduleManager?.installationState());
      });
      return app;
    };
    desktop = await launch();
    let app = desktop;
    const reopen = async () => {
      await app.stop();
      app = desktop = await launch();
      barriers.record("reopened", { url: app.url, native: processes.snapshot() });
      return app;
    };
    const exerciseTools = async () => {
      const bridge = new WorkbenchLanguages();
      try {
        return await bridge.request(app.modules, "qa.ts",
          { method: "diagnostics", version: crypto.randomUUID() },
          () => Promise.resolve('const unused = 1;\nconst wrong: number = "not a number";\n'),
          AbortSignal.timeout(30_000));
      } finally { bridge.clear(); }
    };
    const secret = crypto.randomUUID();
    control = Deno.serve({
      hostname: "127.0.0.1", port: 0, onListen() {},
    }, async (request) => {
      const url = new URL(request.url);
      if (request.headers.has("Origin") ||
          request.headers.get("X-AOT-QA") !== secret ||
          url.hostname !== "127.0.0.1") return new Response("Forbidden", { status: 403 });
      try {
        if (request.method === "GET" && url.pathname === "/events") {
          const after = Number(url.searchParams.get("after") ?? 0);
          if (!Number.isSafeInteger(after) || after < 0) throw new Error("Invalid sequence");
          return Response.json(await barriers.events(after, AbortSignal.any([
            request.signal, shutdown.signal, AbortSignal.timeout(25_000),
          ])));
        }
        if (request.method !== "POST" || url.pathname !== "/control") {
          return new Response("Not found", { status: 404 });
        }
        const text = await request.text();
        if (text.length > 4096) throw new Error("Control frame too large");
        const action = JSON.parse(text);
        switch (action.action) {
          case "arm":
            if (app.application.moduleManager?.installationState().activeOperation) {
              throw new Error("Finish or cancel the active operation before arming");
            }
            barriers.arm(action.barriers, action.failAfterExposure === true);
            break;
          case "release": barriers.release(action.barrier); break;
          case "disconnect":
            app.application.disconnectWorkbench();
            barriers.record("disconnected");
            break;
          case "status": break;
          case "reopen":
            await reopen();
            return Response.json({ url: app.url, native: processes.snapshot() });
          case "execute":
            return Response.json(await app.modules.execute(action.command, action.input ?? null));
          case "tools":
            return Response.json(await exerciseTools());
          case "restart":
            await app.modules.restart(action.id, AbortSignal.timeout(30_000));
            break;
          case "idle": {
            using clock = new IdleClock(60_000);
            await app.modules.execute(action.command, action.input ?? null);
            eq(clock.pending > 0, true);
            clock.advance();
            return Response.json(await app.modules.execute(action.command, action.input ?? null));
          }
          case "stop":
            queueMicrotask(signalStop);
            return Response.json({ stopping: true });
          default: throw new Error("Unknown fixture action");
        }
        return Response.json({
          state: app.application.moduleManager?.installationState(),
          resources: app.modules.resources.inspect(),
          native: processes.snapshot(),
          starts: processes.starts,
          sequence: barriers.trace.length,
        });
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
    });
    Deno.addSignalListener("SIGINT", signalStop);
    Deno.addSignalListener("SIGTERM", signalStop);
    const info = {
      url: `${app.url}/`, root, workspace, profile, packages, rendererDirectory,
      nativeExecutable, control: `http://127.0.0.1:${control.addr.port}`,
      header: { "X-AOT-QA": secret }, pid: Deno.pid,
    };
    console.log(`AOT_QA_READY ${JSON.stringify(info)}`);
    console.log([
      "Parent control: POST /control with the printed X-AOT-QA header and JSON.",
      'Arm before clicking Install: {"action":"arm","barriers":["queued","preparing","committing"]}.',
      'Release each observed phase: {"action":"release","barrier":"queued"} (then preparing, committing).',
      'Subscribe before actions: GET /events?after=<sequence>; returns exact events, never poll.',
      'Cancel with the real UI Cancel installation button while preparing is held.',
      'Disconnect/reconnect: {"action":"disconnect"} while preparing is held; the job remains owned.',
      'Lost response: arm ["response"], wait for exposed/state succeeded, disconnect, release response.',
      'Committed recovery: arm with "failAfterExposure":true; outcome stays succeeded/committed.',
      'Inspect: {"action":"status"}. Execute real command: {"action":"execute","command":"example.rust.count-words","input":"one two"}.',
      'Finish (also on QA failure): {"action":"stop"}, or SIGINT/SIGTERM; await AOT_QA cleaned and process exit.',
    ].join("\n"));
    return { ...info, barriers, processes, get desktop() { return app; },
      reopen, exerciseTools, stop, closed: closed.promise, [Symbol.asyncDispose]: stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

if (import.meta.main) {
  const fixture = await serveInstallationFixture();
  await fixture.closed;
}
