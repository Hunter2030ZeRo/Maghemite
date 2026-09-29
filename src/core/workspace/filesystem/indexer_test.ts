import { CoreBridge, type IndexStatus } from "../../../native/core.ts";
import { WorkspaceIndexService } from "./indexer.ts";

const names: Partial<Record<typeof Deno.build.os, string>> = {
  linux: "libmaghemite_core.so",
  darwin: "libmaghemite_core.dylib",
  windows: "maghemite_core.dll",
};
const libraryName = names[Deno.build.os];
if (!libraryName) {
  throw new Error(`Unsupported test platform: ${Deno.build.os}`);
}

async function waitFor(
  statuses: IndexStatus[],
  predicate: (status: IndexStatus) => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (statuses.some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Expected index update did not arrive within five seconds");
}

Deno.test("OS watcher refreshes changed paths through the native core", async () => {
  const temp = await Deno.makeTempDir({ prefix: "maghemite-watch-" });
  const root = `${temp}/workspace`;
  await Deno.mkdir(root);
  const core = CoreBridge.open(
    new URL(`../../../../native/target/debug/${libraryName}`, import.meta.url),
  );
  const statuses: IndexStatus[] = [];
  const errors: Error[] = [];
  let service: WorkspaceIndexService | undefined;
  try {
    service = await WorkspaceIndexService.open(core, root, {
      dataDirectory: `${temp}/data`,
      onStatus: (status) => statuses.push(status),
      onError: (error) => errors.push(error),
    });
    await waitFor(
      statuses,
      (status) => status.phase === "completed" && status.revision === 1n,
    );
    await Deno.writeTextFile(`${root}/watched.md`, "watch me");
    await waitFor(
      statuses,
      (status) =>
        status.phase === "completed" && status.revision >= 2n &&
        status.added >= 1n,
    );
    if (errors.length) throw errors[0];
  } finally {
    await service?.close();
    core.close();
    await Deno.remove(temp, { recursive: true });
  }
});
