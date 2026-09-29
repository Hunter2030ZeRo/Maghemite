import { ModuleManager } from "../module_manager.ts";
import { ModuleHost } from "../../modules/host/host.ts";
import { ResourceAdmission } from "../../modules/host/resources.ts";
import {
  nativeExecutable,
  openCoordinator,
  requestSignal,
} from "./aot-installation-support.ts";

const [directory, source, operationId] = Deno.args;
if (!directory || !source || !operationId) {
  throw new Error("Expected owned directory, source and operation ID");
}
const resources = new ResourceAdmission({ coreRss: () => 0 });
const host = new ModuleHost({ resources, wasmExecutable: nativeExecutable });
const coordinator = await openCoordinator(host, directory);
const manager = new ModuleManager(host, coordinator, {
  preparation(event) {
    if (event.phase !== "ready") return;
    console.log(
      JSON.stringify({ phase: "ready", pid: event.pid, operationId }),
    );
    return new Promise<void>(() => {});
  },
});
await manager.restore();
const review = await manager.request(
  "modules.prepare",
  { directory: source },
  requestSignal(),
);
if (
  !review || typeof review !== "object" || Array.isArray(review) ||
  typeof review.token !== "string"
) throw new Error("Missing review token");
await manager.request("modules.install", {
  token: review.token,
  operationId,
  grants: ["log", "tasks.progress"],
}, requestSignal());
await manager.drain();
throw new Error("Crash fixture unexpectedly completed");
