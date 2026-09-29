import { rejects, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  prepareRegistration,
  type PreparedRegistrationHandle,
} from "./development.ts";
import { PreparationCoordinator } from "../runtimes/preparation.ts";

const executable = join(
  fileURLToPath(new URL("../../../", import.meta.url)),
  "native",
  "target",
  "release",
  `maghemite-wasm-host${Deno.build.os === "windows" ? ".exe" : ""}`,
);

async function purePackage(directory: string): Promise<void> {
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(
    join(directory, "maghemite.module.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "test.development-lifecycle",
      version: "1.0.0",
      sdkVersion: "0.1.0",
      runtime: "deno",
      entry: "main.ts",
      capabilities: [],
      contributions: {
        commands: [{
          id: "test.development-lifecycle.run",
          title: "Development lifecycle",
        }],
      },
    }),
  );
  await Deno.writeTextFile(
    join(directory, "main.ts"),
    'export default {commands:{"test.development-lifecycle.run":()=>1}};',
  );
}

Deno.test("standalone ownership fails clearly in-use and borrowed handles do not close their coordinator", async () => {
  const base = await Deno.makeTempDir({
    prefix: "maghemite-development-ownership-",
  });
  const source = join(base, "source");
  const storage = join(base, "private");
  let owned: PreparedRegistrationHandle | undefined;
  let coordinator: PreparationCoordinator | undefined;
  try {
    await purePackage(source);
    owned = await prepareRegistration(source, {
      executable,
      storageRoot: storage,
    });
    await rejects(
      prepareRegistration(source, { executable, storageRoot: storage }),
      /already owned/,
    );
    await owned.close();

    coordinator = await PreparationCoordinator.open(storage, { executable });
    const first = await prepareRegistration(source, { coordinator });
    await first.close();
    const second = await prepareRegistration(source, { coordinator });
    strictEqual(second.reused, true);
    await second.close();
  } finally {
    await owned?.close();
    await coordinator?.close();
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("owned handle retries coordinator teardown after a failed close", async () => {
  const base = await Deno.makeTempDir({
    prefix: "maghemite-development-close-",
  });
  const source = join(base, "source");
  const storage = join(base, "private");
  const originalClose = PreparationCoordinator.prototype.close;
  let owned: PreparationCoordinator | undefined;
  let reopened: PreparationCoordinator | undefined;
  let calls = 0;
  try {
    await purePackage(source);
    const registration = await prepareRegistration(source, {
      executable,
      storageRoot: storage,
    });
    PreparationCoordinator.prototype.close = async function () {
      if (this.store.directory === storage) {
        owned = this;
        calls++;
        if (calls === 1) throw new Error("injected teardown failure");
      }
      await originalClose.call(this);
    };
    await rejects(registration.close(), /injected teardown failure/);
    await registration.close();
    reopened = await PreparationCoordinator.open(storage, { executable });
    strictEqual(calls, 2);
  } finally {
    PreparationCoordinator.prototype.close = originalClose;
    await reopened?.close();
    await owned?.close();
    await Deno.remove(base, { recursive: true });
  }
});
