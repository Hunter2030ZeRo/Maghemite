import type { ArtifactDescriptor, ArtifactProducer } from "../../shared/module_aot.ts";
import { AotStore, type AotStaging } from "./aot.ts";
import { canonicalDescriptor, sha256 } from "./aot-schema.ts";

export const fixtureProducer: ArtifactProducer = {
  identity: "c".repeat(64), wasmtimeVersion: "49.0.1", recipeVersion: 1,
  target: "x86_64-unknown-linux-gnu", cpuPolicy: "host-native",
  compilationFingerprint: "0123456789abcdef",
};
export type FixtureKind = "component" | "tools" | "deno" | "theme" | "mixed";

/** Synthetic sources/objects exercise storage only, never native execution. */
export async function storeFixture(kind: FixtureKind = "component") {
  const base = await Deno.makeTempDir({ prefix: "maghemite-aot-test-" });
  try {
    const source = `${base}/source`;
    await Deno.mkdir(source);
    const component = kind === "component" || kind === "mixed";
    const tools = kind === "tools" || kind === "mixed";
    const theme = kind === "theme";
    const core = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    await Deno.writeFile(`${source}/tool.wasm`, core);
    await Deno.writeFile(`${source}/second.wasm`, new Uint8Array([...core, 9]));
    await Deno.writeFile(`${source}/entry.wasm`, new Uint8Array([0, 97, 115, 109, 13, 0, 1, 0]));
    await Deno.writeTextFile(`${source}/main.js`, "export default {};");
    await Deno.writeTextFile(`${source}/theme.json`, JSON.stringify({
      schemaVersion: 1, base: "graphite", colors: { "accent.default": "#abcdef" },
    }));
    const manifest = {
      schemaVersion: 1, sdkVersion: "0.1.0", id: "test.aot", version: "1.0.0",
      ...theme ? {} : {
        runtime: component ? "wasm" : "deno",
        entry: component ? "entry.wasm" : "main.js",
      },
      capabilities: tools ? ["wasm.execute"] : [],
      ...tools ? { wasmTools: [
        {
          id: "zeta", path: "second.wasm", abi: "wasi-preview1",
          sha256: sha256(new Uint8Array([...core, 9])), args: [], stdin: "cooperative-v1",
        },
        { id: "alpha", path: "tool.wasm", abi: "wasi-preview1", sha256: sha256(core), args: [] },
      ] } : {},
      contributions: {
        commands: theme ? [] : [{ id: "test.aot.run", title: "Run" }],
        themes: theme ? [{ id: "test.aot.dark", label: "Dark", path: "theme.json" }] : [],
      },
    };
    await Deno.writeTextFile(`${source}/maghemite.module.json`, JSON.stringify(manifest));
    const store = await AotStore.open(`${base}/private`);
    const reviewed = await store.review(source);
    const snapshot = store.snapshot(reviewed);
    return {
      base, source, store, reviewed, snapshot,
      producers: snapshot.targets.map(() => fixtureProducer),
      async [Symbol.asyncDispose]() { await Deno.remove(base, { recursive: true }); },
    };
  } catch (error) {
    await Deno.remove(base, { recursive: true });
    throw error;
  }
}
export type StoreFixture = Awaited<ReturnType<typeof storeFixture>>;

export async function stagedFixture(fixture: StoreFixture) {
  const stage = await fixture.store.stage(fixture.reviewed, fixture.producers);
  let ordinal = 0;
  const targets = fixture.snapshot.targets.map((source, index) => {
    const bytes = new TextEncoder().encode(`synthetic-object-${index}`);
    return {
      ...source, producer: fixtureProducer,
      artifact: {
        file: source.kind === "component-entry" ? "component.cwasm" : `tool-${ordinal++}.cwasm`,
        size: bytes.length, sha256: sha256(bytes),
      },
    };
  });
  for (const [index, target] of targets.entries()) {
    await Deno.writeTextFile(`${stage.directory}/${target.artifact.file}`, `synthetic-object-${index}`);
  }
  const descriptor: ArtifactDescriptor = {
    schemaVersion: 1, slot: fixture.reviewed.slot, moduleId: "test.aot",
    moduleVersion: "1.0.0", manifestSha256: fixture.snapshot.manifestSha256, targets,
  };
  await writeFixtureDescriptor(stage, descriptor);
  return { stage, descriptor };
}

export async function writeFixtureDescriptor(stage: AotStaging, descriptor: ArtifactDescriptor) {
  await Deno.writeFile(`${stage.directory}/descriptor.json`, canonicalDescriptor(descriptor));
}
