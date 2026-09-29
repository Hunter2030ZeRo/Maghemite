import { deepStrictEqual as eq, ok, rejects } from "node:assert/strict";
import { NativeApplicationServices } from "../core/services/application.ts";
import { WorkspaceHistory } from "./workspaces.ts";
import { fileURLToPath } from "node:url";

Deno.test("folder staging preserves the current workspace on invalid path or cancellation and reuses the core", async () => {
  const directory = await Deno.makeTempDir();
  const a = `${directory}/A`, b = `${directory}/B`;
  await Deno.mkdir(a);
  await Deno.mkdir(b);
  await Deno.writeTextFile(`${a}/a.md`, "# A");
  await Deno.writeTextFile(`${b}/b.md`, "# B");
  const native = await NativeApplicationServices.open({
    dataDirectory: `${directory}/data`,
    coreLibrary: fileURLToPath(
      new URL(
        "../../native/target/release/libmaghemite_core.so",
        import.meta.url,
      ),
    ),
  });
  const caller = {
    moduleId: "qa.workspace",
    signal: new AbortController().signal,
  };
  const files = async () =>
    (await native.request("files.list", {}, caller) as {
      entries: { name: string }[];
    }).entries.map((e) => e.name);
  try {
    await (await native.prepareWorkspace(a))!.commit();
    const core = native.core;
    eq(await files(), ["a.md"]);
    await rejects(() => native.prepareWorkspace(`${directory}/missing`));
    await rejects(() => native.prepareWorkspace(`${a}/a.md`), /directory/);
    await rejects(() => native.prepareWorkspace(directory), /data directory/);
    eq(await native.prepareWorkspace(`${a}/../A`), null);
    const cancelled = (await native.prepareWorkspace(b))!;
    await rejects(() => native.prepareWorkspace(b), /in progress/);
    await cancelled.abort();
    eq(await files(), ["a.md"]);
    await (await native.prepareWorkspace(b))!.commit();
    eq(native.core, core);
    eq(await files(), ["b.md"]);
    await (await native.prepareWorkspace(a))!.commit();
    eq(native.core, core);
    eq(await files(), ["a.md"]);
  } finally {
    await native.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("recent folders persist in MRU order, deduplicate and bound malformed history", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const history = new WorkspaceHistory(directory);
    eq(await history.list(), []);
    for (let i = 0; i < 12; i++) await history.remember(`/project/${i}`);
    await history.remember("/project/5");
    const restored = await new WorkspaceHistory(directory).list();
    eq(restored.length, 10);
    eq(restored[0], "/project/5");
    eq(restored.filter((p) => p === "/project/5").length, 1);
    await Deno.writeTextFile(`${directory}/workspaces.json`, '{"broken":true}');
    eq(await history.list(), []);
    await Deno.writeTextFile(
      `${directory}/workspaces.json`,
      '["/valid","relative",null,"/valid"]',
    );
    eq(await history.list(), ["/valid"]);
    ok((await Deno.stat(`${directory}/workspaces.json`)).isFile);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("folder changes reset active module state without enabling disabled modules", async () => {
  const { ModuleHost } = await import("../modules/host/host.ts");
  const directory = await Deno.makeTempDir();
  const host = new ModuleHost();
  try {
    for (const id of ["qa.enabled", "qa.disabled"]) {
      const path = `${directory}/${id}`;
      await Deno.mkdir(path);
      await Deno.writeTextFile(
        `${path}/maghemite.module.json`,
        JSON.stringify({
          schemaVersion: 1,
          id,
          version: "1.0.0",
          sdkVersion: "0.1.0",
          runtime: "deno",
          entry: "main.js",
          capabilities: [],
          contributions: { commands: [{ id: `${id}.count`, title: "Count" }] },
        }),
      );
      await Deno.writeTextFile(
        `${path}/main.js`,
        `let count=0; export default {commands:{"${id}.count":()=>++count}};`,
      );
      await host.register(path);
    }
    await host.disable("qa.disabled");
    eq(await host.execute("qa.enabled.count", null), 1);
    eq(await host.execute("qa.enabled.count", null), 2);
    await host.resetWorkspace();
    eq(await host.execute("qa.enabled.count", null), 1);
    eq(
      host.list().find((m) => m.manifest.id === "qa.disabled")?.state,
      "disabled",
    );
    await rejects(() => host.execute("qa.disabled.count", null));
  } finally {
    await host.close();
    await Deno.remove(directory, { recursive: true });
  }
});
