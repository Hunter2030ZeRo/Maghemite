import {
  deepStrictEqual as eq,
  ok,
  rejects,
} from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ModuleHost } from "../modules/host/host.ts";
import { AotStore } from "../modules/host/aot.ts";
import { loadPackage } from "../modules/host/manifest.ts";
import { PreparationCoordinator } from "../modules/runtimes/preparation.ts";
import type { ModulePage } from "../shared/module_resources.ts";
import { ModuleManager } from "./module_manager.ts";
import {
  embeddedAssets,
  installedAssets,
  readAssetManifest,
  sha256,
} from "./package_assets.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const nativeExecutable = join(
  root,
  "native/target/release",
  `maghemite-wasm-host${Deno.build.os === "windows" ? ".exe" : ""}`,
);

async function fixture(directory: string, helper?: string) {
  await Deno.mkdir(directory, { recursive: true });
  const contents = new TextEncoder().encode("native fixture");
  const helperBytes = helper ? await Deno.readFile(helper) : contents;
  const manifest = {
    platform: `${Deno.build.os}-${Deno.build.arch}`,
    core: "core",
    wasm: "wasm",
    deno: "deno",
    pty: "pty",
    files: await Promise.all(
      ["core", "wasm", "deno", "pty"].map(async (path) => {
        const bytes = path === "wasm" ? helperBytes : contents;
        await Deno.writeFile(join(directory, path), bytes);
        if (path === "wasm" && Deno.build.os !== "windows") {
          await Deno.chmod(join(directory, path), 0o755);
        }
        return {
          path,
          hash: await sha256(bytes),
          executable: path === "deno" || path === "wasm",
        };
      }),
    ),
  };
  await Deno.writeTextFile(
    join(directory, "assets.json"),
    JSON.stringify(manifest),
  );
  return manifest;
}

Deno.test("installed resources resolve through launcher symlinks without copying or writes", async () => {
  const root = await Deno.makeTempDir({ prefix: "maghemite installed " });
  const app = join(root, "usr/lib/maghemite"), assets = join(app, "assets");
  try {
    const manifest = await fixture(assets);
    await Deno.writeTextFile(join(app, "Maghemite"), "launcher");
    await Deno.mkdir(join(root, "usr/bin"));
    const launcher = join(root, "usr/bin/maghemite");
    await Deno.symlink("../lib/maghemite/Maghemite", launcher);
    await Deno.chmod(assets, 0o555);
    await Deno.chmod(app, 0o555);
    const before = await Deno.stat(join(assets, "core"));
    eq(await installedAssets(launcher), { directory: assets, manifest });
    eq((await Deno.stat(join(assets, "core"))).mtime, before.mtime);
    eq([...Deno.readDirSync(app)].map((e) => e.name).sort(), [
      "Maghemite",
      "assets",
    ]);
  } finally {
    await Deno.chmod(app, 0o755);
    await Deno.chmod(assets, 0o755);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("staged distribution helper prepares and loads source-only modules without legacy cache fallback", async () => {
  const temporary = await Deno.makeTempDir({
    prefix: "maghemite-package-aot-",
  });
  const app = join(temporary, "distribution");
  const assets = join(app, "assets");
  const launcher = join(app, "Maghemite");
  const profile = join(temporary, "profile");
  const exampleDirectory = join(root, "modules-sdk/examples/c");
  const packageDirectory = join(temporary, "source-package");
  let coordinator: PreparationCoordinator | undefined;
  let manager: ModuleManager | undefined;
  let host: ModuleHost | undefined;
  try {
    await fixture(assets, nativeExecutable);
    await Deno.writeTextFile(launcher, "launcher");
    const manifest = JSON.parse(
      await Deno.readTextFile(
        join(exampleDirectory, "maghemite.module.json"),
      ),
    );
    await Deno.mkdir(join(packageDirectory, "dist"), { recursive: true });
    await Deno.copyFile(
      join(exampleDirectory, manifest.entry),
      join(packageDirectory, manifest.entry),
    );
    await Deno.writeTextFile(
      join(packageDirectory, "maghemite.module.json"),
      JSON.stringify(manifest),
    );
    const staged = await installedAssets(launcher);
    const helper = join(staged.directory, staged.manifest.wasm);
    const help = await new Deno.Command(helper, {
      args: ["--help"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    ok(help.success);
    const helpText = new TextDecoder().decode(help.stdout);
    for (
      const mode of [
        "--aot-info",
        "--aot-prepare",
        "--component-aot",
        "--wasi-tool-aot",
      ]
    ) {
      ok(helpText.includes(mode));
    }

    await Deno.mkdir(join(profile, "wasm-cache"), { recursive: true });
    await Deno.writeTextFile(join(profile, "wasm-cache", "legacy"), "legacy");
    const store = await AotStore.open(join(profile, "module-packages"));
    host = new ModuleHost({ wasmExecutable: helper, idleTimeoutMs: 0 });
    coordinator = await PreparationCoordinator.underProfileLock(store, {
      executable: helper,
      resources: host.resources,
    });
    manager = new ModuleManager(host, coordinator);
    await manager.restore();
    const pkg = await loadPackage(packageDirectory);
    const review = await manager.request(
      "modules.prepare",
      { directory: packageDirectory },
      AbortSignal.timeout(30_000),
    );
    ok(
      review && typeof review === "object" && !Array.isArray(review) &&
        typeof review.token === "string",
    );
    await manager.request("modules.install", {
      token: review.token,
      grants: pkg.manifest.capabilities,
      operationId: crypto.randomUUID(),
    }, AbortSignal.timeout(30_000));
    await manager.drain();
    const installed = await manager.request(
      "modules.list",
      { offset: 0 },
      AbortSignal.timeout(30_000),
    ) as ModulePage;
    const installedAotBytes = installed.items[0]?.resources.installedAotBytes;
    ok(typeof installedAotBytes === "number" && installedAotBytes > 0);
    eq(installed.diskUsage.installedAotBytes, installedAotBytes);
    eq(installed.diskUsage.legacyCacheBytes, 6);
    eq(
      await host.execute("example.c.echo", { value: 2 }),
      { value: 2 },
    );

    await Deno.remove(join(profile, "wasm-cache"), { recursive: true });
    eq(
      await host.execute("example.c.echo", { value: 3 }),
      { value: 3 },
    );
    const cacheEvicted = await manager.request(
      "modules.list",
      { offset: 0 },
      AbortSignal.timeout(30_000),
    ) as ModulePage;
    eq(cacheEvicted.diskUsage.legacyCacheBytes, 0);
    eq(cacheEvicted.diskUsage.installedAotBytes, installedAotBytes);

    const liveRegistry = JSON.parse(
      await Deno.readTextFile(join(store.directory, "installed.json")),
    );
    const liveRecord = liveRegistry.records[0];
    const liveGeneration = join(
      store.directory,
      "aot/generations",
      liveRecord.slot,
      liveRecord.artifactSetId,
    );
    const liveDescriptor = JSON.parse(
      await Deno.readTextFile(join(liveGeneration, "descriptor.json")),
    );
    await Deno.remove(
      join(liveGeneration, liveDescriptor.targets[0].artifact.file),
    );
    const missingLive = await manager.request(
      "modules.list",
      { offset: 0 },
      AbortSignal.timeout(30_000),
    ) as ModulePage;
    eq(missingLive.items[0]?.resources.installedAotBytes, null);
    eq(missingLive.diskUsage.installedAotBytes, null);

    await manager.close();
    manager = undefined;
    await host.close();
    host = undefined;

    host = new ModuleHost({ wasmExecutable: helper, idleTimeoutMs: 0 });
    manager = new ModuleManager(host, coordinator);
    await manager.restore();
    const unavailable = await manager.request(
      "modules.list",
      { offset: 0 },
      AbortSignal.timeout(30_000),
    ) as ModulePage;
    eq(unavailable.items[0]?.resources.installedAotBytes, null);
    eq(unavailable.diskUsage.installedAotBytes, null);
    ok(unavailable.items[0]?.error?.includes("unavailable"));
    await rejects(
      () => {
        if (!host) throw new Error("Expected restored host");
        return host.execute("example.c.echo", { value: 1 });
      },
      /unavailable/i,
    );
  } finally {
    await manager?.close();
    await host?.close();
    await coordinator?.close();
    await Deno.remove(temporary, { recursive: true });
  }
});

Deno.test("distributed SDK module targets contain portable wasm source only", async () => {
  let targets = 0;
  let stagedTargets = 0;
  for (
    const packageRoot of [
      join(root, "modules-sdk/examples"),
      join(root, "build/modules"),
    ]
  ) {
    for await (const entry of Deno.readDir(packageRoot)) {
      if (!entry.isDirectory) continue;
      const directory = join(packageRoot, entry.name);
      const pkg = await loadPackage(directory);
      const paths = [
        ...(pkg.manifest.runtime === "wasm" ? [pkg.manifest.entry] : []),
        ...(pkg.manifest.wasmTools ?? []).map((tool) => tool.path),
      ];
      for (const path of paths) {
        if (path === undefined) throw new Error("Missing native source path");
        ok(path.endsWith(".wasm"));
        ok((await Deno.stat(join(directory, path))).isFile);
        targets++;
        if (packageRoot.endsWith("build/modules")) stagedTargets++;
      }
      const pending = [directory];
      while (pending.length) {
        const current = pending.pop();
        if (current === undefined) throw new Error("Missing package directory");
        for await (const item of Deno.readDir(current)) {
          const path = join(current, item.name);
          if (item.isDirectory) pending.push(path);
          else ok(!item.name.endsWith(".cwasm"));
        }
      }
    }
  }
  ok(targets > 0);
  ok(stagedTargets > 0);
});

Deno.test("packaged native mode mismatch is rejected before preparation", async () => {
  const temporary = await Deno.makeTempDir({
    prefix: "maghemite-package-mismatch-",
  });
  let coordinator: PreparationCoordinator | undefined;
  try {
    const assets = join(temporary, "distribution/assets");
    await fixture(assets, Deno.execPath());
    await Deno.writeTextFile(join(temporary, "distribution/Maghemite"), "");
    const staged = await installedAssets(
      join(temporary, "distribution/Maghemite"),
    );
    coordinator = await PreparationCoordinator.open(
      join(temporary, "profile/module-packages"),
      { executable: join(staged.directory, staged.manifest.wasm) },
    );
    await rejects(
      coordinator.info({
        moduleId: "test.packaged",
        generationId: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
      }, AbortSignal.timeout(10_000)),
    );
  } finally {
    await coordinator?.close();
    await Deno.remove(temporary, { recursive: true });
  }
});

Deno.test("portable assets reuse valid sidecars and reject damaged embedded data", async () => {
  const root = await Deno.makeTempDir();
  try {
    const source = join(root, "embedded"), data = join(root, "profile");
    await fixture(source);
    const first = await embeddedAssets(source, data);
    const original = await Deno.stat(join(first.directory, "deno"));
    eq((await embeddedAssets(source, data)).directory, first.directory);
    eq((await Deno.stat(join(first.directory, "deno"))).mtime, original.mtime);
    await Deno.writeTextFile(join(first.directory, "deno"), "damaged cache");
    await embeddedAssets(source, data);
    eq(
      await Deno.readTextFile(join(first.directory, "deno")),
      "native fixture",
    );
    await Deno.writeTextFile(join(source, "core"), "damaged distribution");
    await rejects(
      () => embeddedAssets(source, join(root, "new profile")),
      /Damaged embedded asset/,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("asset manifests reject wrong platforms and traversal before materialization", async () => {
  const root = await Deno.makeTempDir();
  try {
    const manifest = await fixture(root);
    for (
      const path of ["../outside", "/absolute", "a/../outside", "a\\outside"]
    ) {
      await Deno.writeTextFile(
        join(root, "assets.json"),
        JSON.stringify({
          ...manifest,
          files: [{ ...manifest.files[0], path }],
        }),
      );
      await rejects(
        () => readAssetManifest(root),
        /Invalid packaged asset manifest/,
      );
    }
    await Deno.writeTextFile(
      join(root, "assets.json"),
      JSON.stringify({ ...manifest, platform: "other-cpu" }),
    );
    await rejects(() => readAssetManifest(root), /does not match/);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
