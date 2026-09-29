import { deepStrictEqual as eq, ok } from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { ModuleHost } from "../../modules/host/host.ts";
import { ModuleManager } from "../module_manager.ts";
import {
  bounded,
  install,
  installationFixture,
  nativeExecutable,
  openCoordinator,
  outcome,
  requestSignal,
  snapshot,
  writePackage,
} from "./aot-installation-support.ts";

async function terminate(child: Deno.ChildProcess): Promise<void> {
  try {
    child.kill("SIGKILL");
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await bounded(child.status);
}

/** Real parent death, not a hand-written fake activeOperation registry. */
export async function verifyInterruptedInstallation(): Promise<void> {
  await using f = await installationFixture({}, "component");
  const installed = await install(f.manager, f.source, [
    "log",
    "tasks.progress",
  ]);
  await outcome(f.manager, installed.accepted.id);
  const previous = (await f.registry()).records;
  await f.manager.close();
  await f.host.close();
  await f.coordinator.close();
  await writePackage(f.source, 2, "component");
  const operationId = crypto.randomUUID();
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-env",
      "--allow-ffi",
      fileURLToPath(
        new URL("./aot-installation-crash-child.ts", import.meta.url),
      ),
      f.coordinator.store.directory,
      f.source,
      operationId,
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let stopped = false;
  try {
    let text = "";
    while (!text.includes("\n")) {
      const result = await bounded(reader.read());
      if (result.done) {
        throw new Error(`Crash child exited early: ${await stderr}`);
      }
      text += result.value;
    }
    const ready = JSON.parse(text.slice(0, text.indexOf("\n")));
    eq([ready.phase, ready.operationId], ["ready", operationId]);
    ok(Number.isInteger(ready.pid));
    await terminate(child);
    stopped = true;
    const host = new ModuleHost({
      resources: f.resources,
      wasmExecutable: nativeExecutable,
    });
    const coordinator = await openCoordinator(
      host,
      f.coordinator.store.directory,
    );
    const manager = new ModuleManager(host, coordinator);
    try {
      await manager.restore();
      const recovered = snapshot(
        await manager.request(
          "modules.installationStatus",
          { operationId },
          requestSignal(),
        ),
      );
      eq([recovered.phase, recovered.committed], ["failed", false]);
      ok(recovered.error?.includes("interrupted"));
      eq((await f.registry()).records, previous);
      eq(await host.execute("example.rust.count-words", "one two"), {
        words: 2,
      });
      eq(await coordinator.store.orphanStagingIds(), []);
      console.log(
        JSON.stringify({
          recovery: "interrupted",
          operationId,
          parentPid: child.pid,
          preparationPid: ready.pid,
          oldCommand: { words: 2 },
        }),
      );
    } finally {
      await manager.close();
      await host.close();
      await coordinator.close();
    }
  } finally {
    if (!stopped) {
      await terminate(child);
    }
    await reader.cancel();
    reader.releaseLock();
    await stderr;
  }
}
