import { fileURLToPath } from "node:url";
import { buildProject } from "../../../../modules-sdk/tooling/build.ts";
import { createProject } from "../../../../modules-sdk/tooling/project.ts";
import type { PreparedRegistration } from "../host.ts";
import { PreparationCoordinator } from "../../runtimes/preparation.ts";
import { ResourceAdmission } from "../resources.ts";

export const componentExecutable = fileURLToPath(
  new URL(
    "../../../../native/target/release/maghemite-wasm-host",
    import.meta.url,
  ),
);
export const workerModuleId = "test.services";
export const workerCommand = `${workerModuleId}.compute`;
export const parentCommand = `${workerModuleId}.echo`;

const workerSource = `use maghemite_modules_sdk::{Guest, host, tasks, join};
use std::sync::atomic::{AtomicU32, Ordering};
static CALLS: AtomicU32 = AtomicU32::new(0);
struct Module;
impl Guest for Module {
    async fn activate() -> Result<Vec<String>, String> {
        Ok(vec!["${parentCommand}".into(), "${workerCommand}".into()])
    }
    async fn execute(command: String, input: String) -> Result<String, String> {
        if command == "${workerCommand}" {
            host::report_progress(host::Progress {
                message: "worker-started".into(), completed: 0, total: None,
            }).await?;
            let calls = CALLS.fetch_add(1, Ordering::SeqCst) + 1;
            return Ok(format!("{{\\"calls\\":{calls},\\"input\\":{input}}}"));
        }
        let (a, b) = join(
            tasks::run_worker("${workerCommand}".into(), input.clone()),
            tasks::run_worker("${workerCommand}".into(), input),
        ).await;
        Ok(format!("[{},{}]", a?, b?))
    }
    async fn deactivate() -> Result<(), String> { Ok(()) }
}
maghemite_modules_sdk::export!(Module with_types_in maghemite_modules_sdk::bindings);
`;

async function copyPackage(
  source: string,
  destination: string,
): Promise<void> {
  await Deno.mkdir(`${destination}/dist`, { recursive: true });
  await Deno.copyFile(
    `${source}/maghemite.module.json`,
    `${destination}/maghemite.module.json`,
  );
  await Deno.copyFile(
    `${source}/dist/module.wasm`,
    `${destination}/dist/module.wasm`,
  );
}

export function executionResources(
  budgetBytes?: number,
): ResourceAdmission {
  return new ResourceAdmission({
    ...(budgetBytes === undefined ? {} : { budgetBytes }),
    coreRss: () => 0,
    processRss: () => Promise.resolve(null),
    ownedProcesses: () =>
      Promise.resolve({
        source: "unavailable",
        complete: false,
        processes: [],
      }),
  });
}

export function waitForResources(
  resources: ResourceAdmission,
  predicate: () => boolean,
): Promise<void> {
  const completion = Promise.withResolvers<void>();
  const timeout = AbortSignal.timeout(30_000);
  const cleanup = () => {
    resources.removeEventListener("change", check);
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
  resources.addEventListener("change", check);
  timeout.addEventListener("abort", abort, { once: true });
  check();
  return completion.promise;
}

export async function componentEnvironment(
  options: { readonly buildWorker?: boolean } = {},
) {
  const base = await Deno.makeTempDir({
    prefix: "maghemite-aot-component-",
  });
  let coordinator: PreparationCoordinator | undefined;
  try {
    const worker = `${base}/worker`;
    if (options.buildWorker ?? true) {
      const build = `${base}/worker-build`;
      await createProject("rust", build, workerModuleId);
      await Deno.writeTextFile(`${build}/src/lib.rs`, workerSource);
      const manifest = JSON.parse(
        await Deno.readTextFile(`${build}/maghemite.module.json`),
      );
      manifest.capabilities.push("tasks.run-worker");
      manifest.workers = [workerCommand];
      manifest.contributions.commands.push({
        id: workerCommand,
        title: "Compute",
      });
      await Deno.writeTextFile(
        `${build}/maghemite.module.json`,
        JSON.stringify(manifest),
      );
      await buildProject(build);
      await copyPackage(build, worker);
    }
    const sync = `${base}/sync`;
    const syncExample = fileURLToPath(
      new URL("../../../../modules-sdk/examples/csharp-sync/", import.meta.url),
    ).replace(/[\\/]$/, "");
    await copyPackage(syncExample, sync);

    const preparationResources = executionResources();
    coordinator = await PreparationCoordinator.open(`${base}/private`, {
      executable: componentExecutable,
      resources: preparationResources,
    });
    const owner = coordinator;
    return {
      base,
      worker,
      sync,
      store: owner.store,
      preparationResources,
      async prepare(
        source: string,
        operationId: string,
      ): Promise<PreparedRegistration> {
        const reviewed = await owner.store.review(source);
        const prepared = await owner.prepare(reviewed, {
          operationId,
          signal: AbortSignal.timeout(120_000),
        });
        return Object.freeze({ store: owner.store, prepared });
      },
      async [Symbol.asyncDispose]() {
        await owner.close();
        const state = preparationResources.inspect();
        if (
          state.processes.length || state.queued ||
          state.reservedBytes || state.compilation.active
        ) {
          throw new Error("Component fixture retained preparation ownership");
        }
        await Deno.remove(base, { recursive: true });
      },
    };
  } catch (error) {
    await coordinator?.close();
    await Deno.remove(base, { recursive: true });
    throw error;
  }
}

export type ComponentEnvironment = Awaited<
  ReturnType<typeof componentEnvironment>
>;
