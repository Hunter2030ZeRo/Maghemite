import {
  deepStrictEqual,
  ok,
  rejects,
  strictEqual as equal,
} from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAppAPI } from "../../modules-sdk/js/app.ts";
import { NativeApplicationServices } from "../core/services/application.ts";
import { applicationRequest } from "../modules/host/application.ts";
import {
  type PreparedRegistrationHandle,
  prepareRegistration,
} from "../modules/host/development.ts";
import {
  executable,
  writePreparationPackage,
} from "../modules/host/fixtures/aot-preparation-support.ts";

Deno.test("embedding roots registered before creation protect actual native artifacts through aliases", async () => {
  const temporary = await Deno.makeTempDir({
    prefix: "maghemite-private-embedding-",
  });
  const workspace = join(temporary, "workspace");
  const parent = join(temporary, "owned");
  const alias = join(temporary, "owned-alias");
  const storageRoot = join(alias, "future-store");
  let native: NativeApplicationServices | undefined;
  let registration: PreparedRegistrationHandle | undefined;
  try {
    await Deno.mkdir(workspace);
    await Deno.mkdir(parent);
    await Deno.symlink(parent, alias);
    // The protected store does not exist yet, but file authority already does.
    native = await NativeApplicationServices.open({
      root: workspace,
      dataDirectory: join(temporary, "profile"),
      protectedRoots: [storageRoot],
      coreLibrary: fileURLToPath(
        new URL(
          "../../native/target/release/libmaghemite_core.so",
          import.meta.url,
        ),
      ),
    });
    const service = native;
    const api = createAppAPI((method, parameters) =>
      applicationRequest(
        service,
        "qa.embedding",
        new Set(["files.read", "files.write"]),
        { method, parameters },
        AbortSignal.timeout(15_000),
        "qa.embedding-owner",
      )
    );
    const source = join(temporary, "source");
    await writePreparationPackage(source, { component: "async", tools: [] });
    registration = await prepareRegistration(source, {
      executable,
      storageRoot,
      resources: service.resources,
      signal: AbortSignal.timeout(30_000),
    });
    const { directory } = registration.store.details(registration.prepared);
    ok(directory);
    const files = ["descriptor.json", "component.cwasm"];
    const before = await Promise.all(
      files.map((file) => Deno.readFile(join(directory, file))),
    );
    for (
      const forbidden of [
        storageRoot,
        registration.root,
        directory,
        parent,
        alias,
      ]
    ) {
      await rejects(() => service.prepareWorkspace(forbidden), /storage/i);
      equal(service.workspace?.root, workspace);
    }
    const { upload } = await api.files.beginWrite({
      path: "normal.txt",
      version: null,
    });
    await api.files.writeChunk({
      upload,
      offset: 0,
      data: new TextEncoder().encode("ordinary file authority").toBase64(),
    });
    await api.files.commitWrite({ upload });
    equal(
      await Deno.readTextFile(join(workspace, "normal.txt")),
      "ordinary file authority",
    );
    for (const [index, file] of files.entries()) {
      deepStrictEqual(
        await Deno.readFile(join(directory, file)),
        before[index],
      );
    }
    ok(dirname(directory).startsWith(registration.root));
  } finally {
    await registration?.close();
    await native?.close();
    await Deno.remove(temporary, { recursive: true });
  }
});
