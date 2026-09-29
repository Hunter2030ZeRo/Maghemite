import { deepStrictEqual as eq } from "node:assert/strict";
import { nativeExecutable } from "../aot-installation-support.ts";
import { observeNativeProcesses } from "./processes.ts";
import { applicationResources } from "../../../modules/host/resources.ts";

// The real CLI consumes these unchanged arguments. Only its process factory is observed.
const processes = observeNativeProcesses(nativeExecutable);
try {
  await import("../../../../modules-sdk/tooling/cli.ts");
  const state = applicationResources.inspect();
  eq([state.compilation.active, state.queued, state.reservedBytes, state.processes.length],
    [0, 0, 0, 0]);
  console.log(`AOT_SDK_NATIVE ${JSON.stringify(processes.snapshot())}`);
} finally { await processes.close(); }
