import { rejects, strictEqual } from "node:assert/strict";
import { PreparationCoordinator } from "../modules/runtimes/preparation.ts";
import { developmentStorageDirectory } from "../shared/application_paths.ts";
import { startDesktop } from "./main.ts";

Deno.test("desktop retains profile ownership until failed coordinator cleanup retries successfully", async () => {
  const dataDirectory = await Deno.makeTempDir({
    prefix: "maghemite-desktop-aot-close-",
  });
  const args = ["--port=0", `--data-dir=${dataDirectory}`];
  const originalClose = PreparationCoordinator.prototype.close;
  const developmentRoot = developmentStorageDirectory(dataDirectory);
  let desktop: Awaited<ReturnType<typeof startDesktop>> | undefined;
  let reopened: Awaited<ReturnType<typeof startDesktop>> | undefined;
  let owned: PreparationCoordinator | undefined;
  let calls = 0;
  try {
    desktop = await startDesktop(args);
    PreparationCoordinator.prototype.close = async function () {
      if (this.store.directory === developmentRoot) {
        owned = this;
        calls++;
        if (calls === 1) throw new Error("injected desktop teardown failure");
      }
      await originalClose.call(this);
    };
    await rejects(desktop.stop(), /injected desktop teardown failure/);
    await rejects(
      startDesktop(args),
      /profile is already open/,
    );
    await desktop.stop();
    strictEqual(calls, 2);

    reopened = await startDesktop(args);
    await reopened.stop();
  } finally {
    PreparationCoordinator.prototype.close = originalClose;
    await reopened?.stop();
    await desktop?.stop();
    await owned?.close();
    await Deno.remove(dataDirectory, { recursive: true });
  }
});
