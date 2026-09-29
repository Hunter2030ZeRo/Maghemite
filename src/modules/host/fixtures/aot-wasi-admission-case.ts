import { equal, rejects } from "node:assert/strict";
import { interrupted } from "../../runtimes/preparation-process.ts";
import type { WasiEnvironment } from "./aot-wasi-support.ts";

function resourceChange(
  environment: WasiEnvironment,
  predicate: () => boolean,
): Promise<void> {
  const completion = Promise.withResolvers<void>();
  const timeout = AbortSignal.timeout(30_000);
  const cleanup = () => {
    environment.executionResources.removeEventListener("change", check);
    timeout.removeEventListener("abort", abort);
  };
  const check = () => {
    if (!predicate()) return;
    cleanup();
    completion.resolve();
  };
  const abort = () => {
    cleanup();
    completion.reject(timeout.reason);
  };
  environment.executionResources.addEventListener("change", check);
  timeout.addEventListener("abort", abort, { once: true });
  check();
  return completion.promise;
}

export async function verifyWasiAdmission(
  test: Deno.TestContext,
  environment: WasiEnvironment,
): Promise<void> {
  const granted = new Set(["wasm.execute"]);
  const request = (
    owner: string,
    prepared: typeof environment.readiness,
  ) =>
    environment.tools.request({
      pkg: environment.pkg,
      owner,
      granted,
      prepared,
      signal: new AbortController().signal,
    }, { method: "wasm.start", parameters: { tool: "oxc" } });

  await test.step("queued owner release cancels before spawn", async () => {
    const resources = environment.executionResources;
    const retained = 512 * 1024 * 1024;
    const blocker = await resources.acquireLoad({
      moduleId: "test.blocker",
      generationId: "blocker-generation",
      operationId: "blocker-operation",
      kind: "wasi-tool",
      artifactBytes: Math.floor((resources.budgetBytes - retained) / 2) - 1,
    }, AbortSignal.timeout(30_000));
    const queued = resourceChange(
      environment,
      () => resources.queued(environment.pkg.manifest.id) === 1,
    );
    const start = request("queued", environment.readiness);
    try {
      await queued;
      const released = environment.tools.release("queued");
      await rejects(start, /abort|cancel/i);
      await released;
      equal(
        resources.inspect().processes.some((process) =>
          process.moduleId === environment.pkg.manifest.id &&
          process.pid !== null
        ),
        false,
      );
    } finally {
      blocker.release();
      await environment.tools.release("queued");
    }
  });

  await test.step("cancellation after final readiness cannot spawn", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let pins = 0;
    const prepared = {
      ...environment.readiness,
      async pin() {
        const pin = await environment.readiness.pin();
        pins++;
        if (pins === 2) {
          entered.resolve();
          await release.promise;
        }
        return pin;
      },
    };
    const start = request("post-validation", prepared);
    const outcome = start.then(() => null, (error: unknown) => error);
    try {
      await interrupted(Promise.race([
        entered.promise,
        outcome.then((error) => {
          throw error ?? new Error("Tool started without its readiness barrier");
        }),
      ]), AbortSignal.timeout(30_000));
      const released = environment.tools.release("post-validation");
      release.resolve();
      await rejects(start, /abort|cancel/i);
      await released;
      equal(
        environment.executionResources.inspect().processes.some((process) =>
          process.moduleId === environment.pkg.manifest.id &&
          process.pid !== null
        ),
        false,
      );
    } finally {
      release.resolve();
      await environment.tools.release("post-validation");
      await outcome;
    }
  });

  await test.step("stale admission fails current registration fence", async () => {
    const resources = environment.executionResources;
    const retained = 512 * 1024 * 1024;
    const blocker = await resources.acquireLoad({
      moduleId: "test.stale-blocker",
      generationId: "stale-generation",
      operationId: "stale-operation",
      kind: "wasi-tool",
      artifactBytes: Math.floor((resources.budgetBytes - retained) / 2) - 1,
    }, AbortSignal.timeout(30_000));
    const queued = resourceChange(
      environment,
      () => resources.queued(environment.pkg.manifest.id) === 1,
    );
    let current = true;
    const prepared = {
      ...environment.readiness,
      current: () => current,
    };
    const start = request("stale", prepared);
    try {
      await queued;
      current = false;
      blocker.release();
      await rejects(start, /registration changed/);
      equal(
        resources.inspect().processes.some((process) =>
          process.moduleId === environment.pkg.manifest.id &&
          process.pid !== null
        ),
        false,
      );
    } finally {
      blocker.release();
      await environment.tools.release("stale");
    }
  });
}
