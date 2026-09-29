import {
  deepStrictEqual as eq,
  notEqual,
  ok,
  rejects,
} from "node:assert/strict";
import { ModuleHost } from "../../modules/host/host.ts";
import { PreparationCoordinator } from "../../modules/runtimes/preparation.ts";
import { ModuleManager } from "../module_manager.ts";
import { RegistryFile } from "../module_installation_registry.ts";
import { AotError } from "../../shared/module_aot.ts";
import {
  install,
  installationFixture,
  nativeExecutable,
  outcome,
  requestSignal,
} from "./aot-installation-support.ts";

/** Exercises real local engine replacement or legacy migration, without source execution fallback. */
export async function verifyMaintenance(
  kind: "engine" | "legacy",
  enabled: boolean,
): Promise<void> {
  await using f = await installationFixture({}, "component");
  await f.manager.close();
  await f.host.close();
  await f.coordinator.close();
  const executable = `${f.base}/native-host`;
  await Deno.copyFile(nativeExecutable, executable);
  await Deno.chmod(executable, 0o700);
  const directory = `${f.base}/maintenance-private`;
  const coordinator = await PreparationCoordinator.open(directory, {
    executable,
    resources: f.resources,
  });
  let host = new ModuleHost({
    wasmExecutable: executable,
    resources: f.resources,
  });
  let manager = new ModuleManager(host, coordinator);
  const registry = new RegistryFile(directory);
  try {
    if (kind === "legacy") {
      const reviewed = await coordinator.store.review(f.source);
      await Deno.writeTextFile(
        `${directory}/installed.json`,
        JSON.stringify([{
          id: "example.rust",
          slot: reviewed.slot,
          grants: ["log", "tasks.progress"],
          enabled,
        }]),
      );
    } else {
      await manager.restore();
      const installed = await install(manager, f.source, [
        "log",
        "tasks.progress",
      ]);
      eq((await outcome(manager, installed.accepted.id)).phase, "succeeded");
      if (!enabled) {
        await manager.request("modules.configure", {
          id: "example.rust",
          grants: ["log", "tasks.progress"],
          enabled: false,
        }, requestSignal());
      }
      // Change the local producer identity while retaining a real executable.
      const file = await Deno.open(executable, { append: true });
      try {
        await file.write(new Uint8Array([0]));
      } finally {
        file.close();
      }
      if (enabled) {
        await rejects(
          manager.request(
            "modules.restart",
            { id: "example.rust" },
            requestSignal(),
          ),
          /executable/,
        );
      }
      await manager.close();
      await host.close();
      host = new ModuleHost({
        wasmExecutable: executable,
        resources: f.resources,
      });
      manager = new ModuleManager(host, coordinator);
    }
    await registry.read();
    const old = registry.value.records[0];
    let prepares = 0;
    const observe = () => {
      if (f.resources.inspect().compilation.active) prepares++;
    };
    f.resources.addEventListener("change", observe);
    try {
      await manager.restore();
    } finally {
      f.resources.removeEventListener("change", observe);
    }
    eq(prepares, 0);
    eq(manager.installationState().maintenance.length, 1);
    const [accepted] = await manager.maintain("example.rust");
    eq((await outcome(manager, accepted.id)).phase, "succeeded");
    await registry.read();
    const record = registry.value.records[0];
    ok(record.artifactSetId);
    notEqual(record.artifactSetId, old.artifactSetId);
    notEqual(record.slot, old.slot);
    await rejects(
      coordinator.store.restore(old.slot),
      (error: unknown) => error instanceof AotError && error.code === "unavailable",
    );
    eq([record.enabled, record.grants], [enabled, old.grants]);
    if (enabled) {
      eq(await host.execute("example.rust.count-words", "one two"), {
        words: 2,
      });
    } else eq(host.commands(), []);
    console.log(
      JSON.stringify({
        maintenance: kind,
        enabled,
        preparesDuringRestore: prepares,
        operationId: accepted.id,
        freshSlot: record.slot,
        root: f.base,
      }),
    );
  } finally {
    await manager.close();
    await host.close();
    await coordinator.close();
  }
}
