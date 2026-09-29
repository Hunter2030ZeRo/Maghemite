import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { startDesktop } from "../../main.ts";
import { projectLanguageFixture } from "./data.ts";

/** Disposable QA profile. Never installs the fixture into a user's profile. */
if (import.meta.main) {
  const repository = fileURLToPath(new URL("../../../../", import.meta.url));
  const qa = join(repository, ".omo", "qa");
  await Deno.mkdir(qa, { recursive: true });
  const temporary = await Deno.makeTempDir({ dir: qa, prefix: "project-language-" });
  const workspace = join(temporary, "workspace");
  await Deno.mkdir(workspace);
  for (const document of [projectLanguageFixture.main, projectLanguageFixture.target]) {
    await Deno.writeTextFile(join(workspace, document.path), document.text);
  }
  console.log(`Test-only generic fixture: ${temporary}`);
  await startDesktop([
    "--port=0",
    `--workspace=${workspace}`,
    `--data-dir=${join(temporary, "profile")}`,
    "--grant=test.project-language:documents.read",
    "--grant=test.project-language:files.read",
    fileURLToPath(new URL(".", import.meta.url)),
  ]);
}
