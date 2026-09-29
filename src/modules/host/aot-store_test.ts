import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { AotStore } from "./aot.ts";
import { AOT_LIMITS } from "../../shared/module_aot.ts";
import { artifactSetId } from "./aot-schema.ts";
import { stagedFixture, storeFixture } from "./aot-test-fixtures.ts";

Deno.test("pin and committed reference independently prevent reclaim across handles", async () => {
  // Given two handles sharing a generation's owner count.
  await using f = await storeFixture();
  const { stage } = await stagedFixture(f);
  const prepared = await f.store.publish(stage);
  const other = await f.store.lookup(f.reviewed, { artifactSetId: prepared.artifactSetId, producers: f.producers });
  const reference = f.store.retain(prepared);
  const pin = await f.store.pin(other);
  // When dropping each kind of ownership. Then only the final release permits deletion.
  await rejects(() => f.store.reclaim(other), /references/);
  pin.release();
  pin.release();
  await rejects(() => f.store.reclaim(other), /references/);
  reference.release();
  reference.release();
  await f.store.reclaim(other);
  await rejects(() => f.store.pin(prepared), /capability/);
  await f.store.discardReviewed(f.reviewed);
});

Deno.test("admitted pin fences reclaim before asynchronous validation completes", async () => {
  // Given a prepared generation.
  await using f = await storeFixture();
  const { stage } = await stagedFixture(f);
  const prepared = await f.store.publish(stage);
  // When pin and reclaim are issued in the same turn (no timers).
  const pending = f.store.pin(prepared);
  await rejects(() => f.store.reclaim(prepared), /pins/);
  const pin = await pending;
  // Then pin ownership persists until explicit process-exit release.
  pin.release();
  await f.store.reclaim(prepared);
});

Deno.test("reclaim fences new pins before asynchronous removal completes", async () => {
  // Given an unreferenced prepared generation.
  await using f = await storeFixture();
  const { stage } = await stagedFixture(f);
  const prepared = await f.store.publish(stage);
  // When reclaim starts before a new admission.
  const pending = f.store.reclaim(prepared);
  await rejects(() => f.store.pin(prepared), /reclaimed|capability/);
  // Then deletion completes with no admitted owner.
  await pending;
});

Deno.test("snapshot deletion cannot race an in-flight stage creation", async () => {
  // Given a reviewed package with no published generation.
  await using f = await storeFixture();
  // When stage creation starts and deletion races its first await.
  const pending = f.store.stage(f.reviewed, f.producers);
  await rejects(() => f.store.discardReviewed(f.reviewed), /pins|owners/);
  const stage = await pending;
  // Then staging retains the snapshot until discarded.
  await rejects(() => f.store.discardReviewed(f.reviewed), /owners/);
  await f.store.discardStage(stage);
  await f.store.discardReviewed(f.reviewed);
});

Deno.test("publication is immutable and a stage capability is one-shot", async () => {
  // Given a complete published generation.
  await using f = await storeFixture();
  const first = await stagedFixture(f);
  const prepared = await f.store.publish(first.stage);
  const duplicate = await stagedFixture(f);
  // When republishing the same bytes or reusing the spent capability.
  await rejects(() => f.store.publish(first.stage), /capability/);
  await rejects(() => f.store.publish(duplicate.stage), /already exists/);
  // Then the first generation remains valid and unchanged.
  const pin = await f.store.pin(prepared);
  pin.release();
  await f.store.discardStage(duplicate.stage);
});

Deno.test("corruption releases failed admission and is never repaired by lookup", async () => {
  // Given a published object corrupted in place by the host-owned test.
  await using f = await storeFixture();
  const { stage } = await stagedFixture(f);
  const prepared = await f.store.publish(stage);
  const directory = f.store.details(prepared).directory;
  ok(directory);
  await Deno.chmod(`${directory}/component.cwasm`, 0o600);
  await Deno.writeTextFile(`${directory}/component.cwasm`, "corrupt");
  // When pinning or looking up. Then both reject integrity and do not compile/repair.
  await rejects(() => f.store.pin(prepared), /integrity/);
  await rejects(() => f.store.lookup(f.reviewed, { artifactSetId: prepared.artifactSetId, producers: f.producers }), /integrity/);
  equal(await Deno.readTextFile(`${directory}/component.cwasm`), "corrupt");
  await f.store.reclaim(prepared);
});

Deno.test("lookup rejects stale producer identity without rebuilding", async () => {
  // Given a valid generation produced by a different native executable.
  await using f = await storeFixture();
  const { stage } = await stagedFixture(f);
  const prepared = await f.store.publish(stage);
  // When current trusted producer info differs. Then the receipt is incompatible.
  await rejects(() => f.store.lookup(f.reviewed, {
    artifactSetId: prepared.artifactSetId,
    producers: f.producers.map((p) => ({ ...p, identity: "e".repeat(64) })),
  }), /producer/);
});

Deno.test("malformed noncanonical and oversized descriptors are rejected before publication", async () => {
  // Given a valid stage with untrusted bytes replacing its descriptor.
  await using f = await storeFixture();
  const { stage, descriptor } = await stagedFixture(f);
  for (const bytes of ["{", JSON.stringify(descriptor), " ".repeat(AOT_LIMITS.descriptor + 1)]) {
    await Deno.writeTextFile(`${stage.directory}/descriptor.json`, bytes);
    // When publishing. Then syntax, canonical encoding, and byte bounds all apply.
    await rejects(() => f.store.publish(stage));
  }
  await f.store.discardStage(stage);
});

Deno.test("serialized artifact size is checked before reading or allocating its bytes", async () => {
  // Given a sparse serialized object beyond the 1 GiB limit.
  await using f = await storeFixture();
  const { stage } = await stagedFixture(f);
  await Deno.truncate(`${stage.directory}/component.cwasm`, AOT_LIMITS.object + 1);
  // When publishing. Then the size guard rejects immediately.
  await rejects(() => f.store.publish(stage), /size exceeds/);
  await f.store.discardStage(stage);
});

Deno.test("interrupted partial publication is orphaned not adopted after reopen", async () => {
  // Given abandoned partial staging, as after the prior parent exited.
  await using f = await storeFixture("tools");
  const { stage, descriptor } = await stagedFixture(f);
  await Deno.remove(`${stage.directory}/tool-1.cwasm`);
  const reopened = await AotStore.open(f.store.directory);
  const reviewed = await reopened.restore(f.reviewed.slot);
  // When recovery lists abandoned stages. Then it can only discard, never publish them.
  deepStrictEqual(await reopened.orphanStagingIds(), [stage.id]);
  await rejects(() => reopened.publish(stage), /capability/);
  await rejects(() => reopened.lookup(reviewed, { artifactSetId: artifactSetId(descriptor), producers: f.producers }));
  await reopened.discardOrphanStaging(stage.id);
});

Deno.test("staging lease gates publication and busy ownership rejects concurrent discard", async () => {
  // Given the native-style exclusive owner.lock held by a live producer.
  await using f = await storeFixture();
  const { stage } = await stagedFixture(f);
  const owner = await Deno.open(stage.lockPath, { read: true, write: true });
  try {
    await owner.lock(true);
    // When publication starts before termination, teardown cannot race that owner.
    const pending = f.store.publish(stage);
    await rejects(() => f.store.discardStage(stage), /unavailable/);
    await owner.unlock();
    // Then publication completes only after the lease can be acquired.
    const prepared = await pending;
    equal(prepared.slot, f.reviewed.slot);
  } finally { owner.close(); }
});
