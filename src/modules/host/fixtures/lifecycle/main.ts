import type { ModuleDefinition } from "../../../../../modules-sdk/js/mod.ts";

let count = 0;
export default {
  commands: {
    "test.lifecycle.count": () => ({ count: ++count, pid: Deno.pid }),
    "test.lifecycle.fail": () => {
      throw new Error("Lifecycle fixture failure");
    },
    "test.lifecycle.hold": async (_, context) => {
      await context.reportProgress({ message: "held", completed: 0 });
      await context.delay(300_000);
      return null;
    },
    "test.lifecycle.workers": async (_, context) =>
      await Promise.all(
        [1, 2].map((value) =>
          context.runWorker("test.lifecycle.worker", value)
        ),
      ),
    "test.lifecycle.worker": async (_, context) => {
      await context.reportProgress({ message: "worker", completed: 0 });
      await context.delay(300_000);
      return null;
    },
  },
} satisfies ModuleDefinition;
