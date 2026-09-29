import { deepStrictEqual as eq } from "node:assert/strict";
import { ModuleManager } from "./module_manager.ts";
import {
  install,
  installationFixture,
  outcome,
  requestSignal,
  writePackage,
} from "./fixtures/aot-installation-support.ts";

for (const kind of ["deno", "theme"] as const) {
  for (const enabled of [true, false]) {
    Deno.test(`legacy ${kind} restores and updates enabled=${enabled} without native work`, async () => {
      await using f = await installationFixture({}, kind);
      await f.manager.close();
      const reviewed = await f.coordinator.store.review(f.source);
      await Deno.writeTextFile(
        `${f.coordinator.store.directory}/installed.json`,
        JSON.stringify([{
          id: "test.preparation",
          slot: reviewed.slot,
          grants: [],
          enabled,
        }]),
      );
      const manager = new ModuleManager(f.host, f.coordinator);
      let compiler = false;
      const observe = () => {
        compiler ||= f.resources.inspect().compilation.active > 0;
      };
      f.resources.addEventListener("change", observe);
      try {
        await manager.restore();
        eq(manager.installationState().maintenance, []);
        eq((await f.registry()).records[0].artifactSetId, null);
        eq(f.host.list()[0].state, enabled ? "registered" : "disabled");
        await writePackage(f.source, 2, kind);
        const update = await install(manager, f.source);
        eq((await outcome(manager, update.accepted.id)).phase, "succeeded");
        eq(f.host.list()[0].state, enabled ? "registered" : "disabled");
        if (kind === "deno" && enabled) {
          eq(await f.host.execute("test.preparation.run"), 2);
        }
        if (kind === "theme") {
          eq(f.host.themes().themes.length, enabled ? 1 : 0);
        }
        eq(compiler, false);
        await manager.request(
          "modules.remove",
          { id: "test.preparation" },
          requestSignal(),
        );
        eq(f.host.list(), []);
      } finally {
        f.resources.removeEventListener("change", observe);
        await manager.close();
      }
    });
  }
}

Deno.test("failed cutover rolls a disabled installation back without enabling it", async () => {
  let armed = false;
  await using f = await installationFixture({
    boundary: (at) => {
      if (armed && at === "before-rename") {
        throw new Error("rename interrupted");
      }
    },
  });
  const first = await install(f.manager, f.source);
  await outcome(f.manager, first.accepted.id);
  await f.manager.request("modules.configure", {
    id: "test.preparation",
    grants: [],
    enabled: false,
  }, requestSignal());
  const old = (await f.registry()).records;
  await writePackage(f.source, 2);
  armed = true;
  const update = await install(f.manager, f.source);
  eq((await outcome(f.manager, update.accepted.id)).phase, "failed");
  eq((await f.registry()).records, old);
  eq(f.host.list()[0].state, "disabled");
  eq(f.host.commands(), []);
});
