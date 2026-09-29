import { deepStrictEqual as eq, ok } from "node:assert/strict";
import { CoreBridge } from "../../native/core.ts";
import { ownedProcessUsage } from "./process_usage.ts";

const libraryNames: Partial<Record<typeof Deno.build.os, string>> = {
  linux: "libmaghemite_core.so",
  darwin: "libmaghemite_core.dylib",
  windows: "maghemite_core.dll",
};

Deno.test({
  name:
    "native core samples a signalled owned child without Deno proc permission",
  ignore: Deno.build.os !== "linux",
  async fn() {
    const libraryName = libraryNames[Deno.build.os];
    if (!libraryName) throw new Error("Unsupported native test platform");
    const core = CoreBridge.open(
      new URL(`../../../native/target/debug/${libraryName}`, import.meta.url),
    );
    let coreOpen = true;
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        'console.log("ready"); await Deno.stdin.readable.getReader().read();',
      ],
      clearEnv: true,
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    const ready = child.stdout.getReader();
    const deadline = AbortSignal.timeout(5000);
    const abort = () => {
      try {
        child.kill("SIGKILL");
      } catch { /* Already exited. */ }
    };
    deadline.addEventListener("abort", abort, { once: true });
    try {
      let readyLine = "";
      while (!readyLine.includes("\n")) {
        const result = await ready.read();
        ok(!result.done);
        readyLine += new TextDecoder().decode(result.value, { stream: true });
      }
      eq(readyLine, "ready\n");
      const tree = await ownedProcessUsage();
      eq(tree.source, "linux-proc");
      eq(tree.complete, true);
      const observed = tree.processes.find((p) => p.pid === child.pid);
      ok(observed && observed.rssBytes !== null && observed.rssBytes > 0);
      ok(
        tree.processes.every((p) => p.pid !== Deno.pid && p.pid !== Deno.ppid),
      );
      eq(new Set(tree.processes.map((p) => p.pid)).size, tree.processes.length);
      core.close();
      coreOpen = false;
      eq((await ownedProcessUsage()).source, "unavailable");
    } finally {
      deadline.removeEventListener("abort", abort);
      await child.stdin.close();
      await child.status;
      await ready.cancel();
      if (coreOpen) core.close();
    }
  },
});
