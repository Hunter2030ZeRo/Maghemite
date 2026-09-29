import { deepStrictEqual as eq, equal, ok } from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { serveInstallationFixture } from "./fixtures/aot-installation/serve.ts";
import { transportFixture } from "./fixtures/aot-installation/transport.ts";
import { observeNativeProcesses } from "./fixtures/aot-installation/processes.ts";
import { nativeExecutable, snapshot } from "./fixtures/aot-installation-support.ts";
import { IdleClock } from "../modules/host/fixtures/idle-clock.ts";
import { parentCommand, workerCommand } from "../modules/host/fixtures/aot-component-support.ts";
import { prepareRegistration } from "../modules/host/development.ts";
import { ModuleHost } from "../modules/host/host.ts";
import { loadPackage } from "../modules/host/manifest.ts";
import { ResourceAdmission } from "../modules/host/resources.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const grants = ["log", "tasks.progress"];

async function installed(
  client: Awaited<ReturnType<typeof transportFixture>>,
  directory: string,
  granted: string[],
) {
  const installation = await client.install(directory, granted);
  const accepted = snapshot(await installation.accepted);
  const terminal = await client.wait((state) =>
    state.outcomes.some((item) => item.id === accepted.id), 120_000);
  const result = terminal.outcomes.find((item) => item.id === accepted.id);
  ok(result);
  eq([result.phase, result.committed], ["succeeded", true]);
  return result;
}

Deno.test("authenticated installation executes workers tools restart idle and reopened generations with zero producers", async () => {
  await using fixture = await serveInstallationFixture();
  const native = fixture.processes;
  let ready = native.snapshot();
  {
    await using client = await transportFixture({}, undefined, fixture);
    // Given three genuine installations, including a Deno package with two native tools.
    const component = await installed(client, fixture.packages.component, grants);
    const workers = await installed(client, fixture.packages.workers, ["tasks.progress", "tasks.run-worker"]);
    const tools = await installed(client, fixture.packages.executableTools, ["documents.read", "wasm.execute"]);
    eq([component.totalTargets, workers.totalTargets, tools.totalTargets], [1, 1, 2]);
    ready = native.snapshot();
    equal(ready.producers, 3);
    let compilerObserved = false;
    const resources = fixture.desktop.modules.resources;
    const observe = () => { compilerObserved ||= resources.inspect().compilation.active !== 0; };
    resources.addEventListener("change", observe);
    try {
      // When the reviewed distribution is replaced, installed bytes remain immutable.
      await Deno.writeFile(`${fixture.packages.component}/entry.wasm`, new Uint8Array([0]));
      eq(await client.client.execute("example.rust.count-words", "one two"), { words: 2 });
      eq(await client.client.execute(parentCommand, { value: 12 }), [
        { calls: 1, input: { value: 12 } }, { calls: 1, input: { value: 12 } },
      ]);
      const workerStarts = native.starts.filter((item) =>
        item.mode === "--component-aot" && item.args.some((arg) => arg.includes("/generations/")));
      ok(new Set(workerStarts.map((item) => item.pid)).size >= 4);
      const diagnostics = await fixture.exerciseTools();
      ok(diagnostics && typeof diagnostics === "object" && !Array.isArray(diagnostics));
      ok(Array.isArray(diagnostics.result));
      for (const message of ["not assignable", "Oxlint"]) {
        ok(diagnostics.result.some((item) => item && typeof item === "object" &&
          !Array.isArray(item) && typeof item.message === "string" && item.message.includes(message)));
      }
      eq(native.starts.filter((item) => item.mode === "--wasi-tool-aot")
        .map((item) => item.args[5]).sort(), ["blocking", "cooperative-v1"]);
      await client.client.request("modules.restart", { id: "test.services" });
      eq(await client.client.execute(workerCommand, "restart"), { calls: 1, input: "restart" });
      const beforeIdle = native.snapshot().components;
      using clock = new IdleClock(60_000);
      eq(await client.client.execute("example.rust.count-words", "idle"), { words: 1 });
      equal(clock.pending, 1);
      clock.advance();
      // Execute subscribes to the host's exact in-flight suspension before reactivation.
      eq(await client.client.execute("example.rust.count-words", "idle again"), { words: 2 });
      equal(native.snapshot().components, beforeIdle + 1);
      eq([native.snapshot().producers, native.snapshot().info], [ready.producers, ready.info]);
      equal(compilerObserved, false);
      equal(resources.inspect().compilation.active, 0);
    } finally { resources.removeEventListener("change", observe); }
  }
  // Then a fresh desktop owns the persisted references without any source or compiler work.
  await fixture.reopen();
  await using restored = await transportFixture({}, undefined, fixture);
  eq(await restored.client.execute("example.rust.count-words", "closed and reopened"), { words: 3 });
  eq(await restored.client.execute(parentCommand, "restored"), [
    { calls: 1, input: "restored" }, { calls: 1, input: "restored" },
  ]);
  await fixture.exerciseTools();
  eq([native.snapshot().producers, native.snapshot().info], [ready.producers, ready.info]);
  equal(fixture.desktop.modules.resources.inspect().compilation.active, 0);
  console.log("AOT_CONTRACT", JSON.stringify({ prepared: ready, restored: native.snapshot() }));
});

for (const kind of ["rust", "c", "cpp", "python", "csharp", "csharp-sync"]) {
  Deno.test(`AOT example ${kind} uses the existing distribution without execution producers`, async () => {
    const base = await Deno.makeTempDir({ prefix: "maghemite-aot-example-" });
    const processes = observeNativeProcesses(nativeExecutable);
    const resources = new ResourceAdmission({ coreRss: () => 0 });
    const host = new ModuleHost({ resources, wasmExecutable: nativeExecutable, idleTimeoutMs: 0 });
    let prepared: Awaited<ReturnType<typeof prepareRegistration>> | undefined;
    try {
      const source = `${root}modules-sdk/examples/${kind}`;
      const pkg = await loadPackage(source);
      prepared = await prepareRegistration(source, { executable: nativeExecutable, resources, storageRoot: `${base}/private` });
      await host.registerPrepared(prepared, pkg.manifest.capabilities);
      equal(processes.snapshot().producers, 1);
      const baseline = processes.snapshot();
      const input = kind === "rust" ? "one two" : { example: kind, values: [1, true, null] };
      const expected = kind === "rust" ? { words: 2 } : input;
      eq(await host.execute(pkg.manifest.contributions.commands[0].id, input, { timeoutMs: 120_000 }), expected);
      eq([processes.snapshot().producers, processes.snapshot().info], [baseline.producers, baseline.info]);
      equal(resources.inspect().compilation.active, 0);
      console.log("AOT_EXAMPLE", kind, JSON.stringify(processes.snapshot()));
    } finally {
      await host.close();
      await prepared?.close();
      await processes.close();
      eq([resources.inspect().reservedBytes, resources.inspect().processes.length], [0, 0]);
      await Deno.remove(base, { recursive: true });
    }
  });
}

Deno.test("unchanged SDK run prepares once and reuses through the actual CLI process factory", async () => {
  const base = await Deno.makeTempDir({ prefix: "maghemite-aot-sdk-run-" });
  try {
    for (const producers of [1, 0]) {
      const result = await new Deno.Command(Deno.execPath(), {
        args: ["run", "--allow-read", "--allow-write", "--allow-run", "--allow-env",
          `${root}src/desktop/fixtures/aot-installation/sdk-run.ts`, "run",
          "modules-sdk/examples/rust", "example.rust.count-words", '"one two"'],
        cwd: root, env: { XDG_DATA_HOME: `${base}/data` },
        stdout: "piped", stderr: "piped",
      }).output();
      const output = new TextDecoder().decode(result.stdout);
      equal(result.code, 0, new TextDecoder().decode(result.stderr));
      ok(output.split("\n").includes('{"words":2}'));
      const line = output.split("\n").find((line) => line.startsWith("AOT_SDK_NATIVE "));
      ok(line);
      const counts = JSON.parse(line.slice("AOT_SDK_NATIVE ".length));
      eq([counts.producers, counts.components, counts.live], [producers, 1, []]);
      console.log(line);
    }
  } finally { await Deno.remove(base, { recursive: true }); }
});
