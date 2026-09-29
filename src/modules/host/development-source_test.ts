import { rejects, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { AotStore } from "./aot.ts";
import { reviewDevelopmentSource } from "./development-source.ts";

const componentHeader = Uint8Array.of(0, 97, 115, 109, 13, 0, 1, 0);
const toolHeader = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function projectedPackage(directory: string): Promise<void> {
  await Deno.mkdir(join(directory, "assets"), { recursive: true });
  await Deno.writeFile(join(directory, "component.wasm"), componentHeader);
  await Deno.writeFile(join(directory, "tool.wasm"), toolHeader);
  await Deno.writeTextFile(
    join(directory, "maghemite.module.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "test.projected",
      version: "1.0.0",
      sdkVersion: "0.1.0",
      runtime: "wasm",
      entry: "component.wasm",
      capabilities: ["wasm.execute"],
      wasmTools: [{
        id: "tool",
        path: "tool.wasm",
        sha256: sha256(toolHeader),
        abi: "wasi-preview1",
        args: [],
        assets: "assets",
      }],
      contributions: {
        commands: [{ id: "test.projected.run", title: "Projected" }],
      },
    }),
  );
}

Deno.test("development projection rejects symlink ancestors and private-store overlap", async () => {
  const base = await Deno.makeTempDir({
    prefix: "maghemite-development-boundary-",
  });
  const store = await AotStore.open(join(base, "private"));
  try {
    const source = join(base, "source");
    await projectedPackage(source);
    await Deno.mkdir(join(source, "payload"));
    await Deno.rename(
      join(source, "component.wasm"),
      join(source, "payload", "component.wasm"),
    );
    await Deno.symlink("payload", join(source, "linked"));
    const manifestPath = join(source, "maghemite.module.json");
    const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
    manifest.entry = "linked/component.wasm";
    await Deno.writeTextFile(manifestPath, JSON.stringify(manifest));
    await rejects(
      reviewDevelopmentSource(
        store,
        source,
        AbortSignal.timeout(30_000),
      ),
      /symlink/i,
    );

    const overlapping = join(store.directory, "source");
    await projectedPackage(overlapping);
    await rejects(
      reviewDevelopmentSource(
        store,
        overlapping,
        AbortSignal.timeout(30_000),
      ),
      /overlap/i,
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("development projection uses the 192 MiB with-tools package budget", async () => {
  const base = await Deno.makeTempDir({
    prefix: "maghemite-development-budget-",
  });
  const source = join(base, "source");
  const store = await AotStore.open(join(base, "private"));
  try {
    await projectedPackage(source);
    const asset = join(source, "assets", "large.bin");
    await Deno.writeFile(asset, new Uint8Array());
    await Deno.truncate(asset, 97 * 1024 * 1024);
    const reviewed = await reviewDevelopmentSource(
      store,
      source,
      AbortSignal.timeout(30_000),
    );
    strictEqual(store.snapshot(reviewed).package.manifest.id, "test.projected");
    await store.discardReviewed(reviewed);

    await Deno.truncate(asset, 193 * 1024 * 1024);
    await rejects(
      reviewDevelopmentSource(
        store,
        source,
        AbortSignal.timeout(30_000),
      ),
      /size limit/i,
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("development projection preserves depth and entry-count limits", async () => {
  const base = await Deno.makeTempDir({
    prefix: "maghemite-development-limits-",
  });
  const store = await AotStore.open(join(base, "private"));
  try {
    const deep = join(base, "deep");
    await projectedPackage(deep);
    await Deno.mkdir(
      join(deep, "assets", ...Array(32).fill("d")),
      { recursive: true },
    );
    await rejects(
      reviewDevelopmentSource(
        store,
        deep,
        AbortSignal.timeout(30_000),
      ),
      /nesting limit/i,
    );

    const crowded = join(base, "crowded");
    await projectedPackage(crowded);
    for (let index = 0; index < 4092; index++) {
      await Deno.writeFile(
        join(crowded, "assets", `f-${index}`),
        new Uint8Array(),
      );
    }
    await rejects(
      reviewDevelopmentSource(
        store,
        crowded,
        AbortSignal.timeout(30_000),
      ),
      /file count/i,
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
