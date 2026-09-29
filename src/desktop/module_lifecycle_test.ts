import {
  deepStrictEqual as eq,
  notEqual,
  ok,
  rejects,
} from "node:assert/strict";
import { ModuleManager } from "./module_manager.ts";
import { DesktopApplication } from "./application.ts";
import { ModuleHost } from "../modules/host/host.ts";
import { ResourceAdmission } from "../modules/host/resources.ts";
import { fixture as applicationFixture } from "../modules/host/application_fixture.ts";
import type { ModulePage } from "../shared/module_resources.ts";
import { fileURLToPath } from "node:url";
import { openCoordinator } from "./fixtures/aot-installation-support.ts";

const directory = fileURLToPath(
  new URL("../modules/host/fixtures/lifecycle", import.meta.url),
);
const signal = () => AbortSignal.timeout(5000);
const isolatedResources = () =>
  new ResourceAdmission({
    coreRss: () => 0,
    processRss: () => Promise.resolve(null),
  });

Deno.test("manager restart drains real guest workers and retains app documents and drafts", async () => {
  const resources = isolatedResources();
  const workbench = applicationFixture();
  workbench.documents[0].content = "unsaved draft";
  const beforeDocuments = structuredClone(workbench.documents);
  const host = new ModuleHost({ resources, application: workbench.service });
  const data = await Deno.makeTempDir();
  const coordinator = await openCoordinator(host, data);
  const manager = new ModuleManager(host, coordinator);
  const started = Promise.withResolvers<void>();
  let workers = 0;
  try {
    await host.register(directory, ["tasks.progress", "tasks.run-worker"]);
    const before = await host.execute("test.lifecycle.count") as {
      count: number;
      pid: number;
    };
    const work = host.execute("test.lifecycle.workers", null, {
      signal: signal(),
      onProgress: () => {
        if (++workers === 2) started.resolve();
      },
    });
    const cancelled = rejects(work, /cancel|abort|closed/i);
    await Promise.race([started.promise, work]);
    eq(resources.inspect().processes.length, 3);
    await manager.request(
      "modules.restart",
      { id: "test.lifecycle" },
      signal(),
    );
    await cancelled;
    eq(resources.inspect().processes.length, 0);
    eq(resources.inspect().queued, 0);
    eq(workbench.documents, beforeDocuments);
    const page = await manager.request(
      "modules.list",
      {},
      signal(),
    ) as ModulePage;
    eq(page.items[0].state, "registered");
    eq(page.items[0].grants, ["tasks.progress", "tasks.run-worker"]);
    const after = await host.execute("test.lifecycle.count") as {
      count: number;
      pid: number;
    };
    eq(after.count, 1);
    notEqual(after.pid, before.pid);
  } finally {
    await manager.close();
    await host.close();
    await coordinator.close();
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test("runtime failure is visible and restart clears it without automatic retry", async () => {
  const resources = isolatedResources();
  const host = new ModuleHost({ resources });
  const data = await Deno.makeTempDir();
  const coordinator = await openCoordinator(host, data);
  const manager = new ModuleManager(host, coordinator);
  try {
    await host.register(directory);
    await rejects(host.execute("test.lifecycle.fail"), /fixture failure/);
    const page = await manager.request(
      "modules.list",
      {},
      signal(),
    ) as ModulePage;
    eq(page.items[0].state, "failed");
    ok(page.items[0].error?.includes("fixture failure"));
    eq(resources.inspect().reservedBytes, 0);
    await manager.request(
      "modules.restart",
      { id: "test.lifecycle" },
      signal(),
    );
    eq(host.list()[0].error, null);
    eq(
      (await host.execute("test.lifecycle.count") as { count: number }).count,
      1,
    );
    await host.disable("test.lifecycle");
    await rejects(
      manager.request("modules.restart", { id: "test.lifecycle" }, signal()),
      /Enable/,
    );
  } finally {
    await manager.close();
    await host.close();
    await coordinator.close();
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test("failed spawn returns admission and separate hosts share the same default controller", async () => {
  const resources = isolatedResources();
  const host = new ModuleHost({
    resources,
    denoRuntime: { executable: "/nonexistent/maghemite-deno" },
  });
  try {
    await host.register(directory);
    await rejects(host.execute("test.lifecycle.count"));
    eq(resources.inspect().processes, []);
    eq(host.list()[0].state, "failed");
    eq(new ModuleHost().resources, new ModuleHost().resources);
  } finally {
    await host.close();
  }
});

Deno.test("restart cancels a module queued behind a real shared budget", async () => {
  const resources = new ResourceAdmission({
    budgetBytes: 128 * 1048576,
    coreRss: () => 0,
  });
  const blocker = await resources.reserveHostUsage({
    id: "owned:terminal",
    label: "Terminal",
    reservedBytes: 128 * 1048576,
    rssBytes: null,
    diskBytes: null,
  }, signal());
  const host = new ModuleHost({ resources });
  const queued = Promise.withResolvers<void>();
  resources.addEventListener("change", () => {
    if (resources.queued("test.lifecycle") === 1) queued.resolve();
  });
  try {
    await host.register(directory);
    const work = host.execute("test.lifecycle.count", null, {
      signal: signal(),
    });
    const cancelled = rejects(work, /abort|cancel/i);
    await Promise.race([queued.promise, work]);
    await host.restart("test.lifecycle", signal());
    await cancelled;
    eq(resources.inspect().queued, 0);
    eq(resources.inspect().processes, []);
    blocker.release();
    eq(
      (await host.execute("test.lifecycle.count") as { count: number }).count,
      1,
    );
  } finally {
    blocker.release();
    await host.close();
  }
});

Deno.test("status remains readable during restart and protocol-2 registration is invalidated", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const owners: string[] = [];
  let gate = true;
  const host = new ModuleHost({
    resources: isolatedResources(),
    application: {
      methods: () => [],
      request: () => {
        throw new Error("Unexpected application call");
      },
      release: async (owner) => {
        owners.push(owner);
        if (gate) {
          started.resolve();
          await release.promise;
        }
      },
    },
  });
  const data = await Deno.makeTempDir();
  const coordinator = await openCoordinator(host, data);
  const manager = new ModuleManager(host, coordinator);
  try {
    await host.register(
      fileURLToPath(new URL("./fixtures/project-language", import.meta.url)),
      ["documents.read", "files.read"],
    );
    const before = host.languageProvider("source.fixture");
    ok(before);
    const restart = manager.request(
      "modules.restart",
      { id: before.moduleId },
      signal(),
    );
    await Promise.race([started.promise, restart]);
    const page = await manager.request(
      "modules.list",
      {},
      signal(),
    ) as ModulePage;
    eq(page.items[0].state, "restarting");
    eq(host.languageProvider("source.fixture"), null);
    gate = false;
    release.resolve();
    await restart;
    const after = host.languageProvider("source.fixture");
    ok(after?.allowed);
    eq(after.language.protocol, 2);
    notEqual(after.registration, before.registration);
    ok(owners.includes(before.registration));
    await rejects(
      host.executeLanguage("source.fixture", before.registration, null, {}),
      /unavailable/,
    );
  } finally {
    gate = false;
    release.resolve();
    await manager.close();
    await host.close();
    await coordinator.close();
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test("restart exposes deactivation failure after teardown and supports an explicit retry", async () => {
  const resources = isolatedResources();
  const host = new ModuleHost({ resources });
  const directory = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      directory + "/maghemite.module.json",
      JSON.stringify({
        schemaVersion: 1,
        id: "test.cleanup",
        sdkVersion: "0.1.0",
        version: "0.1.0",
        runtime: "deno",
        entry: "main.js",
        capabilities: [],
        contributions: { commands: [{ id: "test.cleanup.run", title: "Run" }] },
      }),
    );
    await Deno.writeTextFile(
      directory + "/main.js",
      'export default {commands:{"test.cleanup.run":()=>null},deactivate(){throw new Error("cleanup failed")}}',
    );
    await host.register(directory);
    await host.execute("test.cleanup.run");
    await rejects(host.restart("test.cleanup", signal()), /cleanup failed/);
    eq(host.list()[0].state, "failed");
    ok(host.list()[0].error?.includes("cleanup failed"));
    eq(resources.inspect().processes, []);
    await host.restart("test.cleanup", signal());
    eq(host.list()[0].state, "registered");
  } finally {
    await host.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("renderer cache reports retain byte provenance without inventing process RSS", async () => {
  const resources = isolatedResources();
  const host = new ModuleHost({ resources });
  const data = await Deno.makeTempDir();
  const coordinator = await openCoordinator(host, data);
  const manager = new ModuleManager(host, coordinator);
  try {
    await manager.request("modules.rendererResources", {
      attachmentBytes: 10 * 1048576,
      attachmentLimitBytes: 64 * 1048576,
    }, signal());
    const page = await manager.request(
      "modules.list",
      {},
      signal(),
    ) as ModulePage;
    const cache = page.resources.external[0];
    eq(cache.id, "renderer.attachments");
    eq(cache.retainedBytes, 10 * 1048576);
    eq(cache.reservedBytes, 64 * 1048576);
    eq(cache.rssBytes, null);
    ok(cache.reportedAt);
    await rejects(
      manager.request("modules.rendererResources", {
        attachmentBytes: -1,
        attachmentLimitBytes: 64 * 1048576,
      }, signal()),
      /Invalid/,
    );
  } finally {
    await manager.close();
    await host.close();
    await coordinator.close();
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test("closing the workbench releases its renderer cache reservation", async () => {
  const resources = isolatedResources(), host = new ModuleHost({ resources });
  const app = new DesktopApplication();
  const data = await Deno.makeTempDir();
  const coordinator = await openCoordinator(host, data);
  app.moduleManager = new ModuleManager(host, coordinator);
  try {
    await app.workbench("modules.rendererResources", {
      attachmentBytes: 1024, attachmentLimitBytes: 64 * 1048576,
    }, signal());
    eq(resources.inspect().external.length, 1);
    app.close();
    eq(resources.inspect().external, []);
  } finally {
    app.close();
    await app.moduleManager.close();
    await host.close();
    await coordinator.close();
    await Deno.remove(data, { recursive: true });
  }
});
