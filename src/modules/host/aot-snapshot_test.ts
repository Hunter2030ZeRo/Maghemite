import { equal, rejects } from "node:assert/strict";
import { AOT_LIMITS } from "../../shared/module_aot.ts";
import { copyReviewedPackage } from "./aot-snapshot.ts";
import { stagedFixture, storeFixture } from "./aot-test-fixtures.ts";

Deno.test("review refuses source symlinks, escape paths and private storage overlap", async () => {
  // Given a valid source with an extra symlink (even one staying inside the source).
  await using f = await storeFixture();
  await Deno.symlink(`${f.source}/entry.wasm`, `${f.source}/alias.wasm`);
  // When reviewing. Then all symlinks, not only manifest paths, are rejected.
  await rejects(() => f.store.review(f.source), /Symlinks/);
  await rejects(() => f.store.review(f.snapshot.package.root), /overlaps/);
  await rejects(() => f.store.restore("../source"), /slot/);
});

Deno.test("review enforces package byte budget without allocating an oversized file", async () => {
  // Given an oversized sparse extra package file.
  await using f = await storeFixture();
  const path = `${f.source}/extra.bin`;
  await Deno.writeFile(path, new Uint8Array());
  await Deno.truncate(path, 96 * 1024 * 1024 + 1);
  // When copying the reviewed package. Then size checking fails before copying it.
  await rejects(() => f.store.review(f.source), /size limit/);
});

Deno.test("review enforces source and descriptor limits at their boundaries", async () => {
  // Given an oversized sparse component source.
  await using f = await storeFixture();
  await Deno.truncate(`${f.source}/entry.wasm`, AOT_LIMITS.component + 1);
  // When reviewing. Then the existing manifest loader's component limit applies.
  await rejects(() => f.store.review(f.source), /64 MiB/);
});

Deno.test("review enforces manifest byte bound before parsing", async () => {
  // Given a manifest larger than the existing 64 KiB JSON boundary.
  await using f = await storeFixture();
  await Deno.writeTextFile(`${f.source}/maghemite.module.json`, " ".repeat(AOT_LIMITS.descriptor + 1));
  // When reviewing. Then oversize data is rejected before JSON parsing.
  await rejects(() => f.store.review(f.source), /too large/);
});

Deno.test("review preserves package depth and entry count limits", async () => {
  // Given a directory chain deeper than the existing 32-level policy.
  await using f = await storeFixture();
  await Deno.mkdir(`${f.source}/${Array(33).fill("d").join("/")}`, { recursive: true });
  // When reviewing. Then the recursive copy is bounded.
  await rejects(() => f.store.review(f.source), /nesting limit/);
});

Deno.test("review rejects more than 4096 entries including directories", async () => {
  // Given empty files beyond the existing total entry limit.
  await using f = await storeFixture("deno");
  for (let i = 0; i < 4096; i++) await Deno.writeFile(`${f.source}/f-${i}`, new Uint8Array());
  // When reviewing. Then empty files cannot evade the count budget.
  await rejects(() => f.store.review(f.source), /file count/);
});

Deno.test("review cancellation leaves no partial snapshot and preserves existing copies", async () => {
  // Given a completed snapshot and an already-cancelled review.
  await using f = await storeFixture();
  const controller = new AbortController();
  controller.abort();
  // When copying. Then cancellation cannot remove or overwrite a prior review.
  await rejects(() => f.store.review(f.source, controller.signal), /abort/i);
  await rejects(() => copyReviewedPackage(f.source, f.snapshot.package.root, new AbortController().signal), /exists/);
  equal(f.store.snapshot(f.reviewed).targets[0]?.sourceSha256, f.snapshot.targets[0]?.sourceSha256);
});

Deno.test("store rejects symlinked generation objects and ancestor directories", async () => {
  // Given an object symlink pointing at otherwise matching bytes.
  await using f = await storeFixture();
  const { stage } = await stagedFixture(f);
  await Deno.copyFile(`${stage.directory}/component.cwasm`, `${f.base}/outside.cwasm`);
  await Deno.remove(`${stage.directory}/component.cwasm`);
  await Deno.symlink(`${f.base}/outside.cwasm`, `${stage.directory}/component.cwasm`);
  // When publishing. Then no-follow storage rejects the alias.
  await rejects(() => f.store.publish(stage), /Symlinks/);
  await f.store.discardStage(stage);
});

Deno.test("restore refuses a slot symlink even inside private storage", async () => {
  // Given a forged alias slot into an existing private package.
  await using f = await storeFixture();
  const slot = "22222222-2222-4222-8222-222222222222";
  await Deno.symlink(f.snapshot.package.root, `${f.store.directory}/packages/${slot}`);
  // When restoring. Then the slot itself is checked, not just its manifest.
  await rejects(() => f.store.restore(slot), /Symlinks/);
});
