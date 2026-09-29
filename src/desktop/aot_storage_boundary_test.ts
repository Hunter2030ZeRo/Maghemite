import {
  deepStrictEqual as equal,
  rejects,
  strictEqual,
} from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAppAPI } from "../../modules-sdk/js/app.ts";
import { NativeApplicationServices } from "../core/services/application.ts";
import { applicationRequest } from "../modules/host/application.ts";
import "./aot_storage_paths_test.ts";
import "./aot_storage_desktop_test.ts";
import "./aot_storage_embedding_test.ts";

const coreLibrary = fileURLToPath(
  new URL("../../native/target/release/libmaghemite_core.so", import.meta.url),
);

Deno.test("standard private roots reject workspace authority before active file drafts change", async () => {
  const temporary = await Deno.makeTempDir({
    prefix: "maghemite-aot-storage-boundary-",
  });
  const profile = join(temporary, "profile");
  const workspace = join(temporary, "workspace");
  const sibling = join(profile, "unrelated-project");
  const packages = join(profile, "module-packages");
  const generation = join(
    packages,
    "aot",
    "generations",
    "qa-slot",
    "qa-set",
  );
  const cache = join(profile, "wasm-cache");
  const alias = join(temporary, "generation-alias");
  let native: NativeApplicationServices | undefined;
  try {
    for (const directory of [workspace, sibling, generation, cache]) {
      await Deno.mkdir(directory, { recursive: true });
    }
    await Deno.writeTextFile(join(workspace, "workspace.txt"), "active");
    await Deno.writeTextFile(join(sibling, "sibling.txt"), "allowed");
    for (const file of ["descriptor.json", "component.cwasm"]) {
      await Deno.writeTextFile(join(generation, file), "private witness");
    }
    await Deno.symlink(generation, alias);

    native = await NativeApplicationServices.open({
      root: workspace,
      dataDirectory: profile,
      coreLibrary,
    });
    const service = native;
    const api = createAppAPI((method, parameters) =>
      applicationRequest(
        service,
        "qa.aot-storage",
        new Set(["files.read", "files.write"]),
        { method, parameters },
        AbortSignal.timeout(15_000),
        "qa.aot-storage-owner",
      )
    );

    const { upload } = await api.files.beginWrite({
      path: "draft.txt",
      version: null,
    });
    await api.files.writeChunk({
      upload,
      offset: 0,
      data: new TextEncoder().encode("draft survives").toBase64(),
    });

    for (const privateRoot of [packages, generation, alias, cache]) {
      await rejects(
        () => service.prepareWorkspace(privateRoot),
        /Private application storage/,
      );
      strictEqual(service.workspace?.root, workspace);
    }

    await api.files.commitWrite({ upload });
    strictEqual(
      await Deno.readTextFile(join(workspace, "draft.txt")),
      "draft survives",
    );
    for (const file of ["descriptor.json", "component.cwasm"]) {
      strictEqual(
        await Deno.readTextFile(join(generation, file)),
        "private witness",
      );
    }

    await (await service.prepareWorkspace(sibling))?.commit();
    equal(
      (await api.files.list({})).entries.map((entry) => entry.name),
      ["sibling.txt"],
    );
    const ordinary = await api.files.beginWrite({
      path: "ordinary.txt",
      version: null,
    });
    await api.files.writeChunk({
      upload: ordinary.upload,
      offset: 0,
      data: new TextEncoder().encode("ordinary").toBase64(),
    });
    await api.files.commitWrite({ upload: ordinary.upload });
    strictEqual(
      await Deno.readTextFile(join(sibling, "ordinary.txt")),
      "ordinary",
    );
  } finally {
    await native?.close();
    await Deno.remove(temporary, { recursive: true });
  }
});
