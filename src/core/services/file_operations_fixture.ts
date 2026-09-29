import { deepStrictEqual as eq, ok } from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAppAPI } from "../../../modules-sdk/js/app.ts";
import { applicationRequest } from "../../modules/host/application.ts";
import { NativeApplicationServices } from "./application.ts";

const coreLibrary = fileURLToPath(
  new URL("../../../native/target/release/libmaghemite_core.so", import.meta.url),
);
const allGrants = [
  "files.read", "files.write", "index.read", "index.write", "events.subscribe",
];
export function apiFor(
  service: NativeApplicationServices,
  grants: ReadonlySet<string> = new Set(allGrants),
) {
  return createAppAPI((method, parameters) =>
    applicationRequest(
      service, "test.file-operations", grants, { method, parameters },
      AbortSignal.timeout(15000), "file-operations-runtime",
    )
  );
}

export async function fixture() {
  const temporary = await Deno.makeTempDir({ prefix: "maghemite-file-operations-" });
  const root = join(temporary, "workspace");
  await Deno.mkdir(root);
  const options = { root, dataDirectory: join(temporary, "data"), coreLibrary };
  let service = await NativeApplicationServices.open(options);
  return {
    root,
    temporary,
    get service() { return service; },
    api: (grants?: ReadonlySet<string>) => apiFor(service, grants),
    async restart() {
      await service.close();
      service = await NativeApplicationServices.open(options);
    },
    async close() {
      await service.close();
      await Deno.remove(temporary, { recursive: true });
    },
  };
}

/** Subscribe before observing state; each wait is for an actual index event. */
export async function indexed(api: ReturnType<typeof apiFor>) {
  const { subscription } = await api.events.subscribe({ topics: ["index.changed"] });
  try {
    const state = await api.index.status({});
    if (state && typeof state === "object" && !Array.isArray(state) && state.phase === "completed") return;
    for (;;) {
      const page = await api.events.next({ subscription, waitMs: 15000 });
      ok(page.events.length > 0, "index completion deadline");
      for (const event of page.events) {
        const state = event.data;
        if (!state || typeof state !== "object" || Array.isArray(state)) continue;
        if (state.phase === "failed") throw new Error(JSON.stringify(state));
        if (state.phase === "completed") return;
      }
    }
  } finally {
    await api.events.unsubscribe({ subscription });
  }
}

// Separate processes prove that no in-memory registry is needed to recover IDs.
if (import.meta.main) {
  const [mode, temporary] = Deno.args;
  const root = join(temporary, "workspace");
  if (mode === "trash") {
    await Deno.mkdir(join(root, "folder", "nested"), { recursive: true });
    await Deno.writeTextFile(join(root, "folder", "nested", "file"), "restart bytes");
    await Deno.chmod(join(root, "folder", "nested", "file"), 0o751);
    await Deno.chmod(join(root, "folder"), 0o750);
  }
  const service = await NativeApplicationServices.open({
    root, dataDirectory: join(temporary, "data"), coreLibrary,
  });
  try {
    const api = apiFor(service);
    switch (mode) {
      case "trash": {
        console.log(JSON.stringify(await api.files.trash({ path: "folder", version: null })));
        break;
      }
      case "restore": {
        const { entries } = await api.files.trashList({});
        eq(entries.length, 1);
        const restored = await api.files.restoreTrash({ id: entries[0].id });
        eq(await Deno.readTextFile(join(root, "folder", "nested", "file")), "restart bytes");
        eq((await Deno.stat(join(root, "folder", "nested", "file"))).mode! & 0o777, 0o751);
        eq((await Deno.stat(join(root, "folder"))).mode! & 0o777, 0o750);
        eq((await api.files.trashList({})).entries, []);
        console.log(JSON.stringify({ id: entries[0].id, ...restored }));
        break;
      }
      default: throw new Error("Unknown fixture mode");
    }
  } finally {
    await service.close();
  }
}
