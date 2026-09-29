import { deepStrictEqual as eq, equal, ok } from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { PreparationCoordinator, type PreparationEvent } from "../../runtimes/preparation.ts";
import { interrupted } from "../../runtimes/preparation-process.ts";
import { ResourceAdmission } from "../resources.ts";
import { artifactSetId, canonicalDescriptor, sha256 } from "../aot-schema.ts";
import type { PreparedPackage } from "../aot.ts";
import { preparationBytes, type PreparationBinary } from "./aot-preparation-binaries.ts";

export const executable = fileURLToPath(new URL("../../../../native/target/release/maghemite-wasm-host", import.meta.url));
export const timeout = () => AbortSignal.timeout(30_000);
export const bounded = <T>(work: Promise<T>) => interrupted(work, timeout());

export interface PreparationFixtureOptions {
  readonly component?: "async" | "sync" | "start";
  readonly tools?: readonly { readonly id: string; readonly source: PreparationBinary; readonly stdin?: "cooperative-v1" }[];
  readonly theme?: boolean;
}

export async function writePreparationPackage(source: string, options: PreparationFixtureOptions) {
  await Deno.mkdir(source, { recursive: true });
  const tools = options.tools ?? [{ id: "engine", source: "tool" }];
  for (const tool of tools) await Deno.writeFile(`${source}/${tool.source}.wasm`, preparationBytes(tool.source));
  if (options.component) await Deno.writeFile(`${source}/entry.wasm`, preparationBytes(options.component));
  await Deno.writeTextFile(`${source}/main.ts`, "throw new Error('Deno entry must not execute during preparation');");
  await Deno.writeTextFile(`${source}/theme.json`, JSON.stringify({
    schemaVersion: 1, base: "graphite", colors: { "accent.default": "#abcdef" },
  }));
  await Deno.writeTextFile(`${source}/maghemite.module.json`, JSON.stringify({
    schemaVersion: 1, sdkVersion: "0.1.0", id: "test.preparation", version: "1.0.0",
    ...options.theme ? {} : {
      runtime: options.component ? "wasm" : "deno",
      entry: options.component ? "entry.wasm" : "main.ts",
      ...options.component ? { wasmProfile: options.component === "async" ? "async" : "sync" } : {},
    },
    capabilities: tools.length ? ["wasm.execute"] : [],
    ...tools.length ? { wasmTools: tools.map((tool) => ({
      id: tool.id, path: `${tool.source}.wasm`, abi: "wasi-preview1",
      sha256: sha256(preparationBytes(tool.source)), args: [],
      ...tool.stdin ? { stdin: tool.stdin } : {},
    })) } : {},
    contributions: options.theme
      ? { themes: [{ id: "test.preparation.dark", label: "Dark", path: "theme.json" }] }
      : { commands: [{ id: "test.preparation.run", title: "Run" }] },
  }));
}

export async function preparationFixture(options: PreparationFixtureOptions = {}) {
  const base = await Deno.makeTempDir({ prefix: "maghemite-aot-preparation-" });
  const resources = new ResourceAdmission({ coreRss: () => 0 });
  const source = `${base}/source`;
  let coordinator: PreparationCoordinator | undefined;
  try {
    await writePreparationPackage(source, options);
    coordinator = await PreparationCoordinator.open(`${base}/private`, { executable, resources });
    const owner = coordinator;
    const store = coordinator.store;
    const reviewed = await store.review(source);
    return {
      base, source, resources, coordinator, store, reviewed,
      async [Symbol.asyncDispose]() {
        await owner.close();
        assertIdle(resources);
        await Deno.remove(base, { recursive: true });
      },
    };
  } catch (error) {
    await coordinator?.close();
    await Deno.remove(base, { recursive: true });
    throw error;
  }
}
export type PreparationFixture = Awaited<ReturnType<typeof preparationFixture>>;

export function assertIdle(resources: ResourceAdmission) {
  const snapshot = resources.inspect();
  eq(snapshot.processes, []);
  equal(snapshot.reservedBytes, 0);
  equal(snapshot.queued, 0);
  equal(snapshot.compilation.active, 0);
}

export async function assertCanonical(f: PreparationFixture, prepared: PreparedPackage) {
  const pin = await f.store.pin(prepared);
  try {
    ok(pin.descriptor && pin.directory);
    equal(pin.descriptor.targets.length, pin.snapshot.targets.length);
    equal(prepared.artifactSetId, artifactSetId(pin.descriptor));
    eq(await Deno.readFile(`${pin.directory}/descriptor.json`), canonicalDescriptor(pin.descriptor));
    for (const target of pin.descriptor.targets) {
      const bytes = await Deno.readFile(`${pin.directory}/${target.artifact.file}`);
      equal(bytes.length, target.artifact.size);
      equal(sha256(bytes), target.artifact.sha256);
      ok(bytes.length > 8);
    }
    return pin.descriptor;
  } finally { pin.release(); }
}

export function barrier(phase: PreparationEvent["phase"]) {
  const entered = Promise.withResolvers<PreparationEvent>();
  const released = Promise.withResolvers<void>();
  return {
    entered: entered.promise, release: () => released.resolve(),
    observe(event: PreparationEvent) {
      if (event.phase !== phase) return;
      entered.resolve(event);
      return released.promise;
    },
  };
}

export function resourceChange(resources: ResourceAdmission, predicate: () => boolean): Promise<void> {
  const completion = Promise.withResolvers<void>();
  const check = () => { if (predicate()) completion.resolve(); };
  resources.addEventListener("change", check);
  check();
  return bounded(completion.promise).finally(() => resources.removeEventListener("change", check));
}

export async function entries(path: string): Promise<string[]> {
  return (await Array.fromAsync(Deno.readDir(path))).map((entry) => entry.name).sort();
}
