import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { startDesktop } from "../../../../desktop/main.ts";

/** Real workbench fixture, always in a disposable profile outside user storage. */
if (import.meta.main) {
  const temporary = await Deno.makeTempDir({
    prefix: "maghemite-module-lifecycle-qa-",
  });
  const workspace = join(temporary, "workspace");
  await Deno.mkdir(workspace);
  await Deno.writeTextFile(join(workspace, "draft.md"), "# Keep this draft\n");
  console.log(`Lifecycle QA profile: ${temporary}`);
  await startDesktop([
    "--port=0",
    `--workspace=${workspace}`,
    `--data-dir=${join(temporary, "profile")}`,
    "--grant=test.lifecycle:tasks.progress",
    "--grant=test.lifecycle:tasks.run-worker",
    fileURLToPath(new URL(".", import.meta.url)),
  ]);
}
