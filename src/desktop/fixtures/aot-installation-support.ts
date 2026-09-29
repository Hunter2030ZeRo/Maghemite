import { deepStrictEqual as eq, ok } from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { Json } from "../../../modules-sdk/js/mod.ts";
import { ModuleHost } from "../../modules/host/host.ts";
import { PreparationCoordinator } from "../../modules/runtimes/preparation.ts";
import { ResourceAdmission } from "../../modules/host/resources.ts";
import { interrupted } from "../../modules/runtimes/preparation-process.ts";
import { writePreparationPackage } from "../../modules/host/fixtures/aot-preparation-support.ts";
import {
  type InstallationTestOptions,
  ModuleManager,
} from "../module_manager.ts";
import type { InstallationSnapshot } from "../../shared/module_installations.ts";
import { parseRegistry } from "../module_installation_registry.ts";

export const nativeExecutable = fileURLToPath(
  new URL(
    "../../../native/target/release/maghemite-wasm-host",
    import.meta.url,
  ),
);
export const requestSignal = () => AbortSignal.timeout(30_000);
export const bounded = <T>(promise: Promise<T>): Promise<T> =>
  interrupted(promise, requestSignal());
export const snapshot = (value: Json): InstallationSnapshot => {
  ok(
    value && typeof value === "object" && !Array.isArray(value) &&
      typeof value.id === "string",
  );
  ok(
    typeof value.moduleId === "string" &&
      (value.kind === "maintenance" || value.kind === "install"),
  );
  ok(
    typeof value.completedTargets === "number" &&
      typeof value.totalTargets === "number" &&
      typeof value.revision === "number",
  );
  ok(
    typeof value.committed === "boolean" &&
      (typeof value.error === "string" || value.error === null),
  );
  return {
    id: value.id,
    moduleId: value.moduleId,
    kind: value.kind,
    phase: parsePhase(value.phase),
    completedTargets: value.completedTargets,
    totalTargets: value.totalTargets,
    revision: value.revision,
    committed: value.committed,
    error: value.error,
  };
};
function parsePhase(value: Json | undefined): InstallationSnapshot["phase"] {
  switch (value) {
    case "queued":
    case "preparing":
    case "committing":
    case "succeeded":
    case "failed":
    case "cancelled":
      return value;
    default:
      throw new Error("Invalid operation phase");
  }
}
export async function openCoordinator(host: ModuleHost, directory: string) {
  return await PreparationCoordinator.open(directory, {
    executable: nativeExecutable,
    resources: host.resources,
  });
}
export async function install(
  manager: ModuleManager,
  source: string,
  grants: string[] = [],
) {
  const review = await manager.request(
    "modules.prepare",
    { directory: source },
    requestSignal(),
  );
  ok(
    review && typeof review === "object" && !Array.isArray(review) &&
      typeof review.token === "string",
  );
  const operationId = crypto.randomUUID();
  const parameters = { token: review.token, grants, operationId };
  const accepted = snapshot(
    await manager.request("modules.install", parameters, requestSignal()),
  );
  return { accepted, parameters };
}
export async function outcome(
  manager: ModuleManager,
  id: string,
): Promise<InstallationSnapshot> {
  await bounded(manager.drain());
  return snapshot(
    await manager.request(
      "modules.installationStatus",
      { operationId: id },
      requestSignal(),
    ),
  );
}
export function gate() {
  const entered = Promise.withResolvers<void>(),
    released = Promise.withResolvers<void>();
  return {
    entered: entered.promise,
    release: () => released.resolve(),
    hold: () => {
      entered.resolve();
      return released.promise;
    },
  };
}
export async function writePackage(
  source: string,
  value = 1,
  kind: "deno" | "component" | "tools" | "theme" = "deno",
) {
  if (kind === "component") {
    const example = fileURLToPath(
      new URL("../../../modules-sdk/examples/rust/", import.meta.url),
    );
    const manifest = JSON.parse(
      await Deno.readTextFile(`${example}/maghemite.module.json`),
    );
    await Deno.mkdir(source, { recursive: true });
    await Deno.copyFile(`${example}/${manifest.entry}`, `${source}/entry.wasm`);
    manifest.entry = "entry.wasm";
    manifest.version = `${value}.0.0`;
    await Deno.writeTextFile(
      `${source}/maghemite.module.json`,
      JSON.stringify(manifest),
    );
    return;
  }
  await writePreparationPackage(source, {
    tools: kind === "tools"
      ? [{ id: "first", source: "tool" }, {
        id: "second",
        source: "cooperative",
        stdin: "cooperative-v1",
      }]
      : [],
    theme: kind === "theme",
  });
  if (kind !== "theme") {
    await Deno.writeTextFile(
      `${source}/main.ts`,
      `export default {commands:{"test.preparation.run":()=>${value}}};`,
    );
  }
  const manifest = JSON.parse(
    await Deno.readTextFile(`${source}/maghemite.module.json`),
  );
  manifest.version = `${value}.0.0`;
  await Deno.writeTextFile(
    `${source}/maghemite.module.json`,
    JSON.stringify(manifest),
  );
}
export async function installationFixture(
  options: InstallationTestOptions = {},
  kind: "deno" | "component" | "tools" | "theme" = "deno",
) {
  const base = await Deno.makeTempDir({ prefix: "maghemite-installation-" });
  const resources = new ResourceAdmission({
    coreRss: () => 0,
    processRss: () => Promise.resolve(null),
    ownedProcesses: () =>
      Promise.resolve({
        source: "unavailable",
        complete: false,
        processes: [],
      }),
  });
  const host = new ModuleHost({
    resources,
    wasmExecutable: nativeExecutable,
    idleTimeoutMs: 0,
  });
  const coordinator = await openCoordinator(host, `${base}/private`);
  const manager = new ModuleManager(host, coordinator, options);
  const source = `${base}/source`;
  try {
    await writePackage(source, 1, kind);
    await manager.restore();
    return {
      base,
      source,
      host,
      coordinator,
      manager,
      resources,
      registry: async () =>
        parseRegistry(
          JSON.parse(
            await Deno.readTextFile(
              `${coordinator.store.directory}/installed.json`,
            ),
          ),
        ),
      async [Symbol.asyncDispose]() {
        try {
          await manager.close();
        } finally {
          try {
            await host.close();
          } finally {
            await coordinator.close();
            const state = resources.inspect();
            eq([
              state.processes.length,
              state.queued,
              state.reservedBytes,
              state.compilation.active,
            ], [0, 0, 0, 0]);
            await Deno.remove(base, { recursive: true });
          }
        }
      },
    };
  } catch (error) {
    await manager.close();
    await host.close();
    await coordinator.close();
    await Deno.remove(base, { recursive: true });
    throw error;
  }
}
