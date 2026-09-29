import { fileURLToPath } from "node:url";
import { equal, ok, rejects } from "node:assert/strict";
import type { Json } from "../../../../modules-sdk/js/mod.ts";
import { ModuleHost, type PreparedRegistration } from "../host.ts";
import { WorkbenchLanguages } from "../../../desktop/languages.ts";
import { preparedToolReadiness } from "../prepared-readiness.ts";
import { ResourceAdmission } from "../resources.ts";
import { WasmTools } from "../wasm_tools.ts";
import { PreparationCoordinator } from "../../runtimes/preparation.ts";

export const wasiRoot = fileURLToPath(
  new URL("../../../../", import.meta.url),
);
export const wasiExecutable =
  `${wasiRoot}native/target/release/maghemite-wasm-host`;

function isolatedResources(): ResourceAdmission {
  return new ResourceAdmission({
    coreRss: () => 0,
    processRss: () => Promise.resolve(null),
    ownedProcesses: () =>
      Promise.resolve({
        source: "unavailable",
        complete: false,
        processes: [],
      }),
  });
}

async function copyTree(source: string, destination: string): Promise<void> {
  const info = await Deno.lstat(source);
  if (info.isDirectory) {
    await Deno.mkdir(destination);
    for await (const entry of Deno.readDir(source)) {
      await copyTree(
        `${source}/${entry.name}`,
        `${destination}/${entry.name}`,
      );
    }
    return;
  }
  if (!info.isFile || info.isSymlink) {
    throw new Error("WASI fixture source contains a special file");
  }
  await Deno.copyFile(source, destination);
}

export async function wasiEnvironment() {
  const base = await Deno.makeTempDir({ prefix: "maghemite-aot-wasi-" });
  const preparationResources = isolatedResources();
  const executionResources = isolatedResources();
  let coordinator: PreparationCoordinator | undefined;
  try {
    const source = `${base}/source`;
    await Deno.mkdir(source);
    for (
      const name of [
        "assets",
        "common",
        "dist",
        "sdk",
        "maghemite.module.json",
        "main.ts",
      ]
    ) {
      await copyTree(
        `${wasiRoot}modules/javascript/${name}`,
        `${source}/${name}`,
      );
    }
    coordinator = await PreparationCoordinator.open(`${base}/private`, {
      executable: wasiExecutable,
      resources: preparationResources,
    });
    const owner = coordinator;
    const reviewed = await owner.store.review(source);
    const prepared = await owner.prepare(reviewed, {
      operationId: "wasi-fixture",
      signal: AbortSignal.timeout(120_000),
    });
    const registration: PreparedRegistration = Object.freeze({
      store: owner.store,
      prepared,
    });
    const pin = await owner.store.pin(prepared);
    const pkg = pin.snapshot.package;
    pin.release();
    const active = { current: true };
    const readiness = preparedToolReadiness(
      registration,
      wasiExecutable,
      () => active.current,
    );
    if (!readiness) {
      throw new Error("WASI fixture did not produce a native generation");
    }
    const tools = new WasmTools(wasiExecutable, executionResources);
    const owners = new Set<string>();
    let generationAvailable = true;
    return {
      base,
      source,
      pkg,
      registration,
      readiness,
      tools,
      executionResources,
      preparationResources,
      invalidate() {
        active.current = false;
      },
      async reclaim() {
        await owner.store.reclaim(prepared);
        generationAvailable = false;
      },
      request(
        ownerId: string,
        granted: ReadonlySet<string>,
        method: string,
        parameters: Record<string, string>,
        signal = new AbortController().signal,
      ): Promise<Json> {
        owners.add(ownerId);
        return tools.request({
          pkg,
          owner: ownerId,
          granted,
          prepared: readiness,
          signal,
        }, { method, parameters });
      },
      async [Symbol.asyncDispose]() {
        for (const ownerId of owners) await tools.release(ownerId);
        if (generationAvailable) await owner.store.reclaim(prepared);
        await owner.store.discardReviewed(reviewed);
        await owner.close();
        const states = [
          preparationResources.inspect(),
          executionResources.inspect(),
        ];
        if (
          states.some((state) =>
            state.processes.length || state.queued || state.reservedBytes ||
            state.compilation.active
          )
        ) {
          throw new Error("WASI fixture retained resource ownership");
        }
        await Deno.remove(base, { recursive: true });
      },
    };
  } catch (error) {
    await coordinator?.close();
    await Deno.remove(base, { recursive: true });
    throw error;
  }
}

export type WasiEnvironment = Awaited<ReturnType<typeof wasiEnvironment>>;

export async function verifyWasiHostExecution(): Promise<void> {
  await using environment = await wasiEnvironment();
  const host = new ModuleHost({
    wasmExecutable: wasiExecutable,
    resources: environment.executionResources,
    idleTimeoutMs: 0,
  });
  const bridge = new WorkbenchLanguages();
  let compilerPermitObserved = false;
  const observe = () => {
    compilerPermitObserved ||= environment.executionResources.inspect()
      .processes.some((process) => process.compilerPermit);
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
    const response = await bridge.request(
      host,
      "test.ts",
      { method: "diagnostics", version: "1" },
      () => Promise.resolve(source),
      AbortSignal.timeout(30_000),
    );
    ok(response && typeof response === "object" && !Array.isArray(response));
    const result = response.result;
    ok(Array.isArray(result));
    for (const expected of ["not assignable", "Oxlint"]) {
      ok(
        result.some((diagnostic) =>
          diagnostic && typeof diagnostic === "object" &&
          "message" in diagnostic &&
          typeof diagnostic.message === "string" &&
          diagnostic.message.includes(expected)
        ),
      );
    }
    await rejects(
      environment.registration.store.reclaim(
        environment.registration.prepared,
      ),
      /active pins or installation references/,
    );
  } finally {
    environment.executionResources.removeEventListener("change", observe);
    bridge.clear();
    await host.close();
  }
  equal(compilerPermitObserved, false);
  equal(environment.executionResources.inspect().processes.length, 0);
}
