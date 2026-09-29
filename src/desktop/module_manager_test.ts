import { deepStrictEqual as eq, rejects } from "node:assert/strict";
import { ModuleHost } from "../modules/host/host.ts";
import { ModuleManager } from "./module_manager.ts";
import { openCoordinator } from "./fixtures/aot-installation-support.ts";
const signal = new AbortController().signal;
Deno.test("module manager reviews immutable packages, persists grants, updates, disables and removes", async () => {
  const dir = await Deno.makeTempDir(), source = `${dir}/source`;
  let host = new ModuleHost();
  const coordinator = await openCoordinator(host, `${dir}/installed`);
  let manager = new ModuleManager(host, coordinator);
  try {
    await Deno.mkdir(source);
    const manifest = {
      schemaVersion: 1,
      id: "test.managed",
      version: "1.0.0",
      sdkVersion: "0.1.0",
      runtime: "deno",
      entry: "main.js",
      capabilities: ["log"],
      contributions: { commands: [{ id: "test.managed.run", title: "Test" }] },
    };
    await Deno.writeTextFile(
      `${source}/maghemite.module.json`,
      JSON.stringify(manifest),
    );
    await Deno.writeTextFile(
      `${source}/main.js`,
      'export default { commands: { "test.managed.run": async (_,ctx) => { await ctx.log("hello"); return 1; } } };',
    );
    await manager.restore();
    const review = await manager.request("modules.prepare", {
      directory: source,
    }, signal) as { token: string; grants: string[] };
    eq(review.grants, []);
    eq(host.list().length, 0);
    await Deno.writeTextFile(
      `${source}/main.js`,
      'throw Error("changed original");',
    );
    await rejects(
      () =>
        manager.request("modules.install", {
          token: review.token,
          grants: ["files.write"],
          operationId: crypto.randomUUID(),
        }, signal),
      /declared/,
    );
    await manager.request("modules.install", {
      token: review.token,
      grants: ["log"],
      operationId: crypto.randomUUID(),
    }, signal);
    await manager.drain();
    eq(await host.execute("test.managed.run", null), 1);
    await manager.request("modules.configure", {
      id: manifest.id,
      grants: [],
      enabled: true,
    }, signal);
    await rejects(
      () => host.execute("test.managed.run", null),
      /denied|grant|capability/i,
    );
    await manager.request("modules.configure", {
      id: manifest.id,
      grants: ["log"],
      enabled: false,
    }, signal);
    eq(host.commands(), []);
    await manager.close();
    await host.close();
    host = new ModuleHost();
    manager = new ModuleManager(host, coordinator);
    await manager.restore();
    eq(host.list()[0].state, "disabled");
    manifest.version = "2.0.0";
    manifest.capabilities.push("tasks.progress");
    await Deno.writeTextFile(
      `${source}/maghemite.module.json`,
      JSON.stringify(manifest),
    );
    await Deno.writeTextFile(
      `${source}/main.js`,
      'export default { commands: { "test.managed.run": () => 2 } };',
    );
    const update = await manager.request("modules.prepare", {
      directory: source,
    }, signal) as { token: string; grants: string[]; update: boolean };
    eq(update.update, true);
    eq(update.grants, ["log"]);
    await manager.request("modules.install", {
      token: update.token,
      grants: update.grants,
      operationId: crypto.randomUUID(),
    }, signal);
    await manager.drain();
    eq(host.list()[0].state, "disabled");
    await manager.request("modules.configure", {
      id: manifest.id,
      grants: [],
      enabled: true,
    }, signal);
    eq(await host.execute("test.managed.run", null), 2);
    await manager.request("modules.remove", { id: manifest.id }, signal);
    eq(host.list(), []);
    eq(
      JSON.parse(await Deno.readTextFile(`${dir}/installed/installed.json`)).records,
      [],
    );
  } finally {
    await manager.close();
    await host.close();
    await coordinator.close();
    await Deno.remove(dir, { recursive: true });
  }
});
Deno.test("module manager refuses symlink packages and removes cancelled staging copies", async () => {
  const dir = await Deno.makeTempDir(),
    source = `${dir}/source`,
    host = new ModuleHost();
  const coordinator = await openCoordinator(host, `${dir}/installed`);
  const manager = new ModuleManager(host, coordinator);
  try {
    await Deno.mkdir(source);
    await Deno.writeTextFile(
      `${source}/maghemite.module.json`,
      JSON.stringify({
        schemaVersion: 1,
        id: "test.link",
        version: "1.0.0",
        sdkVersion: "0.1.0",
        runtime: "deno",
        entry: "main.js",
        capabilities: [],
        contributions: { commands: [{ id: "test.link.run", title: "Test" }] },
      }),
    );
    await Deno.writeTextFile(
      `${source}/main.js`,
      'export default {commands:{"test.link.run":()=>null}}',
    );
    await manager.restore();
    const review = await manager.request("modules.prepare", {
      directory: source,
    }, signal) as { token: string };
    await manager.request("modules.cancel", { token: review.token }, signal);
    await rejects(
      () =>
        manager.request(
          "modules.install",
          { token: review.token, grants: [], operationId: crypto.randomUUID() },
          signal,
        ),
      /expired/,
    );
    if (Deno.build.os !== "windows") {
      await Deno.symlink(`${source}/main.js`, `${source}/link.js`);
      await rejects(
        () => manager.request("modules.prepare", { directory: source }, signal),
        /symlinks/i,
      );
    }
    eq(host.list(), []);
  } finally {
    await manager.close();
    await host.close();
    await coordinator.close();
    await Deno.remove(dir, { recursive: true });
  }
});
