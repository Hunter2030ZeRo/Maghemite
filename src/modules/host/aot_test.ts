import { deepStrictEqual, equal, notEqual, ok, rejects, throws } from "node:assert/strict";
import { AotStore } from "./aot.ts";
import { artifactSetId } from "./aot-schema.ts";
import { stagedFixture, storeFixture, writeFixtureDescriptor } from "./aot-test-fixtures.ts";
import "./aot-schema_test.ts";
import "./aot-snapshot_test.ts";
import "./aot-store_test.ts";

for (const kind of ["component", "tools", "mixed", "deno", "theme"] as const) {
  Deno.test(`complete target set: ${kind} publishes only declared targets`, async () => {
    // Given a package (including undeclared .wasm files) in private storage.
    await using f = await storeFixture(kind);
    const native = f.snapshot.targets.length > 0;
    const staged = native ? await stagedFixture(f) : null;
    // When publishing/looking up the complete preparation.
    const prepared = staged
      ? await f.store.publish(staged.stage)
      : await f.store.lookup(f.reviewed, { artifactSetId: null, producers: [] });
    const lookup = await f.store.lookup(f.reviewed, { artifactSetId: prepared.artifactSetId, producers: f.producers });
    const pin = await f.store.pin(lookup);
    // Then the exact declared set is bound and pinned, without invoking native code.
    try {
      equal(pin.snapshot.targets.length, { component: 1, tools: 2, mixed: 3, deno: 0, theme: 0 }[kind]);
      equal(pin.descriptor?.targets.length ?? 0, pin.snapshot.targets.length);
      equal(pin.directory === null, !native);
      if (kind === "tools") deepStrictEqual(pin.snapshot.targets.map((t) => [t.toolId, t.abi]), [
        ["alpha", "wasi-p1-blocking-v1"], ["zeta", "wasi-p1-cooperative-v1"],
      ]);
      await rejects(() => f.store.reclaim(prepared), /pins/);
    } finally { pin.release(); }
    await f.store.reclaim(prepared);
    await f.store.discardReviewed(f.reviewed);
  });
}

Deno.test("complete target set rejects incomplete staged output despite producer success text", async () => {
  // Given a two-tool stage with a misleading successful receipt but missing object.
  await using f = await storeFixture("tools");
  const { stage, descriptor } = await stagedFixture(f);
  await Deno.remove(`${stage.directory}/tool-1.cwasm`);
  await Deno.writeTextFile(`${stage.directory}/success.log`, "preparation succeeded");
  // When publication is attempted. Then no generation is returned or visible.
  await rejects(() => f.store.publish(stage));
  await rejects(() => f.store.lookup(f.reviewed, { artifactSetId: artifactSetId(descriptor), producers: f.producers }));
  await f.store.discardStage(stage);
});

Deno.test("complete target set rejects missing target and swapped tool identity", async () => {
  // Given a valid stage whose receipt lies about the reviewed target set.
  await using f = await storeFixture("tools");
  const { stage, descriptor } = await stagedFixture(f);
  const [first, second] = descriptor.targets;
  ok(first && second);
  for (const targets of [
    [first],
    [
      { ...first, sourcePath: second.sourcePath, sourceSha256: second.sourceSha256, sourceSize: second.sourceSize },
      { ...second, sourcePath: first.sourcePath, sourceSha256: first.sourceSha256, sourceSize: first.sourceSize },
    ],
  ]) {
    await writeFixtureDescriptor(stage, { ...descriptor, targets });
    // When publishing. Then completeness/binding, not receipt honesty, decides.
    await rejects(() => f.store.publish(stage), /complete|binding/);
  }
  await f.store.discardStage(stage);
});

Deno.test("same-version source changes never select an old generation", async () => {
  // Given a published old package and a byte change without a version bump.
  await using f = await storeFixture();
  const first = await stagedFixture(f);
  const old = await f.store.publish(first.stage);
  await Deno.writeFile(`${f.source}/entry.wasm`, new Uint8Array([0, 97, 115, 109, 13, 0, 1, 1]));
  const changed = await f.store.review(f.source);
  // When looking up the old committed ID under the new reviewed package.
  await rejects(() => f.store.lookup(changed, { artifactSetId: old.artifactSetId, producers: f.producers }));
  // Then exact bytes changed despite identical version; old private bytes are intact.
  notEqual(f.store.snapshot(changed).targets[0]?.sourceSha256, f.snapshot.targets[0]?.sourceSha256);
  equal(f.store.snapshot(changed).package.manifest.version, f.snapshot.package.manifest.version);
  const pin = await f.store.pin(old);
  pin.release();
});

Deno.test("private snapshot remains stable across external source mutation barrier", async () => {
  // Given the review completion as the deterministic source-mutation barrier.
  await using f = await storeFixture();
  await Deno.writeTextFile(`${f.source}/entry.wasm`, "mutated externally");
  // When staging and publishing the reviewed private snapshot.
  const { stage } = await stagedFixture(f);
  const prepared = await f.store.publish(stage);
  // Then publication uses the reviewed source digest, never the source directory.
  equal(f.store.details(prepared).descriptor?.targets[0]?.sourceSha256, f.snapshot.targets[0]?.sourceSha256);
});

Deno.test("publication rejects private source mutation after staging", async () => {
  // Given a producer result and a subsequently altered private source.
  await using f = await storeFixture();
  const { stage } = await stagedFixture(f);
  const entry = `${f.snapshot.package.root}/entry.wasm`;
  await Deno.chmod(entry, 0o600);
  await Deno.writeTextFile(entry, "changed");
  // When publishing. Then stale source authority cannot publish.
  await rejects(() => f.store.publish(stage), /snapshot changed/);
  await f.store.discardStage(stage);
});

Deno.test("forged capabilities and guest receipt/object pairs cannot authorize publication", async () => {
  // Given honest private output and a guest-side matching copied receipt/object pair.
  await using f = await storeFixture();
  const { stage, descriptor } = await stagedFixture(f);
  await Deno.copyFile(`${stage.directory}/descriptor.json`, `${f.source}/descriptor.json`);
  await Deno.copyFile(`${stage.directory}/component.cwasm`, `${f.source}/component.cwasm`);
  const other = await AotStore.open(`${f.base}/other-private`);
  // When callers substitute copied object shapes or another store's capabilities.
  await rejects(() => f.store.publish({ ...stage }), /capability/);
  await rejects(() => other.publish(stage), /capability/);
  await rejects(() => f.store.lookup({ ...f.reviewed }, { artifactSetId: artifactSetId(descriptor), producers: f.producers }), /capability/);
  const prepared = await f.store.publish(stage);
  throws(() => f.store.details({ ...prepared }), /capability/);
  // Then the trusted store still accepts only its original capability.
  equal(f.store.details(prepared).descriptor?.moduleId, "test.aot");
});

Deno.test("complete target set preserves source aliases through publication lookup and pin", async () => {
  // Given a manifest-valid first/second pair sharing one engine.wasm source.
  await using f = await storeFixture("tools");
  const tool = f.snapshot.package.manifest.wasmTools?.find((t) => t.id === "alpha");
  ok(tool);
  const manifest = {
    ...f.snapshot.package.manifest,
    wasmTools: ["first", "second"].map((id) => ({ ...tool, id, path: "engine.wasm" })),
  };
  await Deno.copyFile(`${f.source}/tool.wasm`, `${f.source}/engine.wasm`);
  await Deno.writeTextFile(`${f.source}/maghemite.module.json`, JSON.stringify(manifest));
  const reviewed = await f.store.review(f.source);
  const snapshot = f.store.snapshot(reviewed);
  const { stage } = await stagedFixture({ ...f, reviewed, snapshot });
  // When the real store publishes and loads the complete generation.
  const prepared = await f.store.publish(stage);
  const found = await f.store.lookup(reviewed, {
    artifactSetId: prepared.artifactSetId, producers: f.producers,
  });
  const pin = await f.store.pin(found);
  // Then both identities survive with independent generated artifact bindings.
  try {
    deepStrictEqual(
      pin.descriptor?.targets.map((t) => [t.toolId, t.sourcePath, t.artifact.file]),
      [
        ["first", "engine.wasm", "tool-0.cwasm"],
        ["second", "engine.wasm", "tool-1.cwasm"],
      ],
    );
  } finally { pin.release(); }
  await f.store.reclaim(prepared);
  await f.store.discardReviewed(reviewed);
});

for (const kind of ["component", "tools", "deno", "theme"] as const) {
  Deno.test(`committed ${kind} restores opaque capabilities without producer metadata`, async () => {
    await using f = await storeFixture(kind);
    const staged = f.snapshot.targets.length ? await stagedFixture(f) : null;
    const prepared = staged
      ? await f.store.publish(staged.stage)
      : await f.store.lookup(f.reviewed, { artifactSetId: null, producers: [] });
    const reopened = await AotStore.open(f.store.directory);
    const restored = await reopened.restorePrepared(prepared.slot, prepared.artifactSetId);
    const pin = await reopened.pin(restored);
    try {
      equal(pin.snapshot.package.manifest.id, "test.aot");
      deepStrictEqual(pin.descriptor, f.store.details(prepared).descriptor);
    } finally { pin.release(); }
    const reference = reopened.retain(restored);
    await rejects(() => reopened.reclaim(restored), /references/);
    reference.release();
    await reopened.reclaim(restored);
    await rejects(() => reopened.restorePrepared(restored.slot, restored.artifactSetId));
  });
}

Deno.test("committed restoration still rejects wrong IDs source mutation and damaged objects", async () => {
  await using f = await storeFixture("component");
  const staged = await stagedFixture(f);
  const prepared = await f.store.publish(staged.stage);
  const reopened = await AotStore.open(f.store.directory);
  await rejects(() => reopened.restorePrepared(prepared.slot, null));
  await rejects(() => reopened.restorePrepared(prepared.slot, "0".repeat(64)));
  const details = f.store.details(prepared);
  ok(details.directory);
  const source = `${details.snapshot.package.root}/entry.wasm`;
  const original = await Deno.readFile(source);
  await Deno.chmod(source, 0o600);
  await Deno.writeFile(source, new Uint8Array([...original, 0]));
  await rejects(() => reopened.restorePrepared(prepared.slot, prepared.artifactSetId), /binding/);
  await Deno.writeFile(source, original);
  await Deno.chmod(source, 0o400);
  await Deno.chmod(`${details.directory}/component.cwasm`, 0o600);
  await Deno.writeTextFile(`${details.directory}/component.cwasm`, "corrupt");
  await rejects(() => reopened.restorePrepared(prepared.slot, prepared.artifactSetId), /integrity/);
});
