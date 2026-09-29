import { equal, ok } from "node:assert/strict";
import { AotStore } from "../aot.ts";
import { canonicalDescriptor, sha256 } from "../aot-schema.ts";
import {
  AotError, type ArtifactDescriptor, type ArtifactProducer,
} from "../../../shared/module_aot.ts";

async function rejection(action: () => Promise<unknown>, code: string) {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof AotError)) throw error;
    equal(error.code, code);
    return { code: error.code, message: error.message };
  }
  throw new Error(`Expected ${code} rejection; action unexpectedly succeeded`);
}

const root = await Deno.makeTempDir({ prefix: "maghemite-aot-store-probe-" });
try {
  const source = `${root}/source`;
  await Deno.mkdir(source);
  await Deno.writeTextFile(`${source}/maghemite.module.json`, JSON.stringify({
    schemaVersion: 1, id: "test.aot", version: "1.0.0", sdkVersion: "0.1.0",
    runtime: "wasm", entry: "entry.wasm", capabilities: [],
    contributions: { commands: [{ id: "test.aot.run", title: "Run" }] },
  }));
  await Deno.writeFile(`${source}/entry.wasm`, new Uint8Array([0, 97, 115, 109, 13, 0, 1, 0]));
  const store = await AotStore.open(`${root}/private`);
  const reviewed = await store.review(source);
  const snapshot = store.snapshot(reviewed);
  const producer: ArtifactProducer = {
    identity: "c".repeat(64), wasmtimeVersion: "49.0.1", recipeVersion: 1,
    target: "x86_64-unknown-linux-gnu", cpuPolicy: "host-native",
    compilationFingerprint: "storage-probe-only",
  };
  const stage = await store.stage(reviewed, [producer]);
  const bytes = new TextEncoder().encode("synthetic-local-object");
  const target = snapshot.targets[0];
  ok(target);
  const descriptor: ArtifactDescriptor = {
    schemaVersion: 1, slot: reviewed.slot, moduleId: "test.aot",
    moduleVersion: "1.0.0", manifestSha256: snapshot.manifestSha256,
    targets: [{
      ...target, producer,
      artifact: { file: "component.cwasm", size: bytes.length, sha256: sha256(bytes) },
    }],
  };
  await Deno.writeFile(`${stage.directory}/component.cwasm`, bytes);
  await Deno.writeFile(`${stage.directory}/descriptor.json`, canonicalDescriptor(descriptor));
  const prepared = await store.publish(stage);
  console.log(JSON.stringify({
    action: "publish", result: "PASS", proof: "storage-only; no native execution",
    slot: prepared.slot, artifactSetId: prepared.artifactSetId,
    snapshot: store.details(prepared),
  }));
  const found = await store.lookup(reviewed, { artifactSetId: prepared.artifactSetId, producers: [producer] });
  const pin = await store.pin(found);
  try {
    console.log(JSON.stringify({ action: "lookup-pin", result: "PASS", directory: pin.directory }));
    const blocked = await rejection(() => store.reclaim(prepared), "in-use");
    console.log(JSON.stringify({ action: "reclaim-pinned", result: "REJECTED", actual: blocked }));
  } finally { pin.release(); }
  const directory = store.details(prepared).directory;
  ok(directory);
  await Deno.chmod(`${directory}/component.cwasm`, 0o600);
  await Deno.writeTextFile(`${directory}/component.cwasm`, "corrupted");
  const corrupt = await rejection(
    () => store.lookup(reviewed, { artifactSetId: prepared.artifactSetId, producers: [producer] }),
    "integrity",
  );
  console.log(JSON.stringify({ action: "lookup-corruption", result: "REJECTED", actual: corrupt }));
  await store.reclaim(prepared);
  await store.discardReviewed(reviewed);
  console.log(JSON.stringify({ action: "release-reclaim", result: "PASS" }));
} finally {
  await Deno.remove(root, { recursive: true });
  console.log(JSON.stringify({ action: "cleanup", result: "PASS", removed: root }));
}
