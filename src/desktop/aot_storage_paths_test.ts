import { strictEqual as equal } from "node:assert/strict";
import { join } from "node:path";
import {
  applicationPathsOverlap,
  canonicalApplicationPath,
} from "../shared/application_paths.ts";

Deno.test("private overlap uses complete path components and Windows volume rules", () => {
  for (
    const [left, right, expected] of [
      ["/data/modules", "/data/modules/aot", true],
      ["/data/modules/aot", "/data/modules", true],
      ["/data/modules", "/data/modules-other", false],
      ["/data/Modules", "/data/modules", false],
      ["/data/modules/../workspace", "/data/modules", false],
    ] as const
  ) {
    equal(applicationPathsOverlap(left, right, "posix"), expected);
  }
  for (
    const [left, right, expected] of [
      ["C:\\Data\\Modules", "c:/data/modules/aot", true],
      ["C:\\Data\\Modules\\aot", "c:\\DATA\\modules", true],
      ["C:\\Data\\Modules", "C:\\Data\\Modules-other", false],
      ["C:\\Data\\Modules", "D:\\Data\\Modules", false],
      ["\\\\Server\\Share\\Modules", "\\\\server\\share\\modules\\aot", true],
      ["\\\\server\\share\\modules", "\\\\server\\other\\modules", false],
    ] as const
  ) {
    equal(applicationPathsOverlap(left, right, "windows"), expected);
  }
});

Deno.test("prospective private paths resolve existing aliases before creation", async () => {
  const temporary = await Deno.makeTempDir({
    prefix: "maghemite-private-path-",
  });
  try {
    const real = join(temporary, "real");
    const alias = join(temporary, "alias");
    await Deno.mkdir(real);
    await Deno.symlink(real, alias);
    const future = join(real, "future", "aot");
    equal(await canonicalApplicationPath(join(alias, "future", "aot")), future);
    await Deno.mkdir(future, { recursive: true });
    equal(await canonicalApplicationPath(join(alias, "future", "aot")), future);
  } finally {
    await Deno.remove(temporary, { recursive: true });
  }
});
