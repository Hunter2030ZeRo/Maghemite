import { CoreBridge, CoreStatusError, type IndexStatus } from "./core.ts";

const libraryNames: Partial<Record<typeof Deno.build.os, string>> = {
  linux: "libmaghemite_core.so",
  darwin: "libmaghemite_core.dylib",
  windows: "maghemite_core.dll",
};
const libraryName = libraryNames[Deno.build.os];
if (!libraryName) {
  throw new Error(`Unsupported test platform: ${Deno.build.os}`);
}

async function waitForTerminal(
  core: CoreBridge,
  jobId: bigint,
): Promise<IndexStatus> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const status = core.indexStatus(jobId);
    if (
      status.phase === "completed" || status.phase === "failed" ||
      status.phase === "cancelled"
    ) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Index did not finish within five seconds");
}

async function waitForIndex(
  core: CoreBridge,
  jobId: bigint,
): Promise<IndexStatus> {
  const status = await waitForTerminal(core, jobId);
  if (status.phase === "failed") throw new Error(core.indexError(jobId));
  if (status.phase === "cancelled") throw new Error("Index was cancelled");
  return status;
}

Deno.test("Deno FFI indexes a workspace and reconciles changes", async () => {
  const temp = await Deno.makeTempDir({ prefix: "maghemite-ffi-" });
  const root = `${temp}/workspace`;
  const database = `${temp}/data/index.sqlite`;
  await Deno.mkdir(root);
  await Deno.writeTextFile(`${root}/first.md`, "one");

  const core = CoreBridge.open(
    new URL(`../../native/target/debug/${libraryName}`, import.meta.url),
  );
  let workspaceId: bigint | undefined;
  try {
    try {
      core.openWorkspace(root, `${root}/index.sqlite`);
      throw new Error("Database inside workspace was accepted");
    } catch (error) {
      if (!(error instanceof CoreStatusError) || error.code !== 1) throw error;
    }
    workspaceId = core.openWorkspace(root, database);
    try {
      core.refreshPaths(workspaceId, [`${temp}/outside.md`]);
      throw new Error("Refresh outside workspace was accepted");
    } catch (error) {
      if (!(error instanceof CoreStatusError) || error.code !== 1) throw error;
    }
    const firstJob = core.startIndex(workspaceId);
    const first = await waitForIndex(core, firstJob);
    if (first.scanned !== 1n || first.added !== 1n || first.revision !== 1n) {
      throw new Error(
        `Unexpected initial status: ${
          JSON.stringify(
            first,
            (_, value) => typeof value === "bigint" ? value.toString() : value,
          )
        }`,
      );
    }
    core.releaseIndex(firstJob);

    await Deno.remove(`${root}/first.md`);
    await Deno.writeTextFile(
      `${root}/second.ts`,
      "export const build = () => 1;",
    );
    const secondJob = core.refreshPaths(workspaceId, [
      `${root}/first.md`,
      `${root}/second.ts`,
    ]);
    const second = await waitForIndex(core, secondJob);
    if (
      second.added !== 1n || second.removed !== 1n || second.revision !== 2n
    ) {
      throw new Error(
        `Unexpected reconciliation status: ${
          JSON.stringify(second, (_, value) =>
            typeof value === "bigint" ? value.toString() : value)
        }`,
      );
    }
    core.releaseIndex(secondJob);

    await Deno.mkdir(`${root}/notes`);
    await Deno.writeTextFile(`${root}/notes/third.md`, "three");
    const thirdJob = core.refreshPaths(workspaceId, [`${root}/notes`]);
    const third = await waitForIndex(core, thirdJob);
    if (third.added !== 2n || third.revision !== 3n) {
      throw new Error("Directory refresh missed a child");
    }
    core.releaseIndex(thirdJob);

    await Deno.remove(`${root}/notes`, { recursive: true });
    const fourthJob = core.refreshPaths(workspaceId, [`${root}/notes`]);
    const fourth = await waitForIndex(core, fourthJob);
    if (fourth.removed !== 2n || fourth.revision !== 4n) {
      throw new Error("Directory removal left stale entries");
    }
    core.releaseIndex(fourthJob);

    const finalJob = core.startIndex(workspaceId);
    const final = await waitForIndex(core, finalJob);
    if (final.added !== 0n || final.removed !== 0n || final.revision !== 5n) {
      throw new Error("Full scan did not retain refreshed entries");
    }
    core.releaseIndex(finalJob);

    await Deno.remove(root, { recursive: true });
    const failedJob = core.startIndex(workspaceId);
    const failed = await waitForTerminal(core, failedJob);
    if (failed.phase !== "failed" || failed.errorCode !== 6) {
      throw new Error("Missing workspace root did not fail the scan");
    }
    core.releaseIndex(failedJob);

    await Deno.mkdir(root);
    await Deno.writeTextFile(
      `${root}/second.ts`,
      "export const build = () => 1;",
    );
    const recoveryJob = core.startIndex(workspaceId);
    const recovery = await waitForIndex(core, recoveryJob);
    if (
      recovery.revision !== 6n || recovery.added !== 0n ||
      recovery.removed !== 0n
    ) {
      throw new Error("Failed scan changed the committed index");
    }
    core.releaseIndex(recoveryJob);
    core.closeWorkspace(workspaceId);
    workspaceId = undefined;
  } finally {
    core.close();
    await Deno.remove(temp, { recursive: true });
  }
});
