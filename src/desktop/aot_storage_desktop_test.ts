import { ok, rejects, strictEqual as equal } from "node:assert/strict";
import { dirname, join } from "node:path";
import {
  defaultDataDirectory,
  developmentStorageDirectory,
  retainedNativeCacheRoots,
} from "../shared/application_paths.ts";
import { startDesktop } from "./main.ts";

Deno.test("custom desktop profiles protect default developer storage and retained caches before initial open", async () => {
  const temporary = await Deno.makeTempDir({
    prefix: "maghemite-private-desktop-",
  });
  const variable = Deno.build.os === "windows"
    ? "LOCALAPPDATA"
    : Deno.build.os === "darwin"
    ? "HOME"
    : "XDG_DATA_HOME";
  const previous = Deno.env.get(variable);
  Deno.env.set(variable, join(temporary, "default-data"));
  let desktop: Awaited<ReturnType<typeof startDesktop>> | undefined;
  try {
    const profile = join(temporary, "custom-profile");
    const developer = developmentStorageDirectory(defaultDataDirectory());
    const descendant = join(developer, "aot", "generations");
    const cache = join(defaultDataDirectory(), "wasm-cache");
    const cacheChild = join(cache, "old-native-objects");
    const alias = join(temporary, "developer-alias");
    const workspace = join(temporary, "workspace");
    ok(!(await retainedNativeCacheRoots()).includes(cache));
    for (const path of [descendant, cacheChild, workspace]) {
      await Deno.mkdir(path, { recursive: true });
    }
    await Deno.symlink(developer, alias);
    ok((await retainedNativeCacheRoots()).includes(cache));
    for (
      const forbidden of [
        developer,
        descendant,
        dirname(developer),
        alias,
        cache,
        cacheChild,
      ]
    ) {
      await rejects(
        startDesktop([
          "--port=0",
          `--data-dir=${profile}`,
          `--workspace=${forbidden}`,
        ]),
        /storage/i,
      );
    }
    // Failed initial opens release the profile lease; an ordinary open still works.
    desktop = await startDesktop([
      "--port=0",
      `--data-dir=${profile}`,
      `--workspace=${workspace}`,
    ]);
    const response = await fetch(`${desktop.url}/api/workbench/session`, {
      headers: { "X-Maghemite-Client": "1" },
    });
    equal(response.status, 200);
    await response.arrayBuffer();
  } finally {
    await desktop?.stop();
    if (previous === undefined) Deno.env.delete(variable);
    else Deno.env.set(variable, previous);
    await Deno.remove(temporary, { recursive: true });
  }
});
