/** Standalone real-surface proof for prepared Deno-owned WASI tools. */
import { equal, ok, rejects } from "node:assert/strict";
import { ModuleHost } from "../host.ts";
import { WorkbenchLanguages } from "../../../desktop/languages.ts";
import { wasiEnvironment, wasiExecutable } from "./aot-wasi-support.ts";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object");
  }
  return Object.fromEntries(Object.entries(value));
}

let removedRoot = "";
{
  await using environment = await wasiEnvironment();
  removedRoot = environment.base;
  const host = new ModuleHost({
    wasmExecutable: wasiExecutable,
    resources: environment.executionResources,
    idleTimeoutMs: 0,
  });
  const bridge = new WorkbenchLanguages();
  const pids = new Set<number>();
  let compilerPermitObserved = false;
  const observe = () => {
    for (const process of environment.executionResources.inspect().processes) {
      if (process.pid !== null) pids.add(process.pid);
      compilerPermitObserved ||= process.compilerPermit;
    }
  };
  environment.executionResources.addEventListener("change", observe);
  try {
    await host.registerPrepared(environment.registration, [
      "documents.read",
      "wasm.execute",
    ]);
    await Deno.remove(`${environment.source}/assets`, { recursive: true });
    await Deno.remove(`${environment.source}/dist`, { recursive: true });

    const source = 'const unused = 1;\nconst wrong: number = "not a number";\n';
    const response = object(
      await bridge.request(
        host,
        "probe.ts",
        { method: "diagnostics", version: "1" },
        () => Promise.resolve(source),
        AbortSignal.timeout(30_000),
      ),
    );
    const diagnostics = response.result;
    ok(Array.isArray(diagnostics));
    const messages = diagnostics.flatMap((diagnostic) => {
      if (
        !diagnostic || typeof diagnostic !== "object" ||
        !("message" in diagnostic) ||
        typeof diagnostic.message !== "string"
      ) return [];
      return [diagnostic.message];
    });
    ok(messages.some((message) => message.includes("not assignable")));
    ok(messages.some((message) => message.includes("Oxlint")));
    equal(environment.executionResources.inspect().compilation.active, 0);
    await rejects(
      environment.reclaim(),
      /active pins or installation references/,
    );
    console.log(JSON.stringify({
      action: "module-host-both-modes",
      diagnostics: messages,
      pids: [...pids],
      compilerActive: 0,
      immutableAssets: true,
    }));

    const granted = new Set(["wasm.execute"]);
    const call = (
      owner: string,
      method: string,
      parameters: Record<string, string>,
      signal = new AbortController().signal,
    ) => environment.request(owner, granted, method, parameters, signal);
    const blockingId = object(
      await call("cancel-owner", "wasm.start", { tool: "oxc" }),
    ).id;
    ok(typeof blockingId === "string");
    const cancel = new AbortController();
    const pending = call(
      "cancel-owner",
      "wasm.read",
      { id: blockingId },
      cancel.signal,
    );
    await rejects(
      () => call("cancel-owner", "wasm.read", { id: blockingId }),
      /busy/,
    );
    cancel.abort();
    await rejects(() => pending);
    await environment.tools.release("cancel-owner");

    const cooperativeId = object(
      await call("release-owner", "wasm.start", { tool: "typescript" }),
    ).id;
    ok(typeof cooperativeId === "string");
    await environment.tools.release("release-owner");
    console.log(JSON.stringify({
      action: "cancellation-owner-release",
      blockingId,
      cooperativeId,
      resources: environment.executionResources.inspect(),
    }));

    await host.unregister("maghemite.javascript");
    bridge.clear();
    await host.close();
    await environment.reclaim();
    equal(compilerPermitObserved, false);
    const final = environment.executionResources.inspect();
    equal(final.processes.length, 0);
    equal(final.queued, 0);
    equal(final.reservedBytes, 0);
    console.log(JSON.stringify({
      action: "generation-reclaimed",
      artifactSetId: environment.registration.prepared.artifactSetId,
      compilerPermitObserved,
      pids: [...pids],
      resources: final,
    }));
  } finally {
    environment.executionResources.removeEventListener("change", observe);
    bridge.clear();
    await host.close();
  }
}
console.log(JSON.stringify({
  action: "cleanup",
  removed: removedRoot,
  receipt:
    "module host, broker pipes, generation reference, store lock and temp profile drained",
}));
