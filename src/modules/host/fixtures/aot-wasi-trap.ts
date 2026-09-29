import { equal, ok } from "node:assert/strict";
import { AotLoadSignal } from "../../runtimes/compilation.ts";
import {
  assertIdle,
  executable,
  preparationFixture,
  timeout,
} from "./aot-preparation-support.ts";

const unreachableTrap = /wasm trap: wasm `unreachable` instruction executed/;

export async function verifyPreparedWasiTrap(): Promise<void> {
  await using fixture = await preparationFixture();
  const prepared = await fixture.coordinator.prepare(fixture.reviewed, {
    operationId: "prepare-wasi-witness",
    signal: timeout(),
  });
  const pin = await fixture.store.pin(prepared);
  const target = pin.descriptor?.targets.find((item) =>
    item.kind === "wasi-tool" && item.toolId === "engine"
  );
  ok(pin.directory && prepared.artifactSetId && target);
  const lease = await fixture.resources.acquireLoad({
    moduleId: "test.witness",
    generationId: prepared.artifactSetId,
    operationId: "wasi-witness",
    kind: "wasi-tool",
    artifactBytes: target.artifact.size,
  }, timeout());
  const child = new Deno.Command(executable, {
    args: [
      "--wasi-tool-aot",
      pin.directory,
      prepared.artifactSetId,
      "engine",
      "",
      "blocking",
      "--",
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    clearEnv: true,
    env: { MAGHEMITE_LOAD_NOTIFY: "1" },
  }).spawn();
  lease.attach(child.pid);
  const loaded = new AotLoadSignal();
  let diagnostic = "";
  const stderr = (async () => {
    for await (const bytes of child.stderr) {
      loaded.consume(bytes);
      diagnostic += new TextDecoder().decode(bytes);
    }
  })();
  const stdout = Array.fromAsync(child.stdout);
  const status = child.status;
  try {
    await loaded.wait(timeout());
    lease.loaded();
    const result = await status;
    await Promise.all([stderr, stdout]);
    equal(result.code, 1);
    console.log(JSON.stringify({
      witness: "wasi-start",
      exitCode: result.code,
      diagnostic,
    }));
    ok(unreachableTrap.test(diagnostic), diagnostic);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch { /* Already exited. */ }
    await Promise.allSettled([status, stderr, stdout]);
    lease.release();
    pin.release();
  }
  assertIdle(fixture.resources);
}
