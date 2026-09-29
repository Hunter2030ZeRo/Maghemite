import { deepStrictEqual as eq, ok, rejects } from "node:assert/strict";
import { join } from "node:path";
import { fixture } from "../core/services/file_operations_fixture.ts";
import type { NativeApplicationServices } from "../core/services/application.ts";
import type { Json } from "../../modules-sdk/js/mod.ts";
import { WorkbenchFiles } from "./file_operations.ts";

function coordinator(
  native: NativeApplicationServices,
  workbench: (method: string, parameters: Json) => Promise<Json>,
  bindings = new Map<string, { path: string; version: string }>(),
) {
  return new WorkbenchFiles({
    native, bindings, workbench,
    documentsBusy: () => false,
    invalidateLanguages() {},
  });
}
const caller = () => ({
  moduleId: "maghemite.workbench", owner: "workbench", signal: AbortSignal.timeout(15000),
});

Deno.test("workbench move rewrites unopened links and advances only matching disk bindings", async () => {
  const f = await fixture();
  try {
    // Given real notes, including an unopened backlink.
    await Deno.mkdir(join(f.root, "notes"));
    await Deno.mkdir(join(f.root, "archive"));
    await Deno.writeTextFile(join(f.root, "notes/A.md"), "[[B#Heading|Label]] [B.md](B.md)\r\n");
    await Deno.writeTextFile(join(f.root, "notes/B.md"), "# B\r\n");
    const api = f.api();
    const a = await api.files.stat({ path: "notes/A.md" });
    const b = await api.files.stat({ path: "notes/B.md" });
    ok(a.version && b.version);
    const bindings = new Map([
      ["notes/A.md", { path: "notes/A.md", version: a.version }],
      ["notes/B.md", { path: "notes/B.md", version: b.version }],
    ]);
    const messages: { method: string; parameters: Json }[] = [];
    const files = coordinator(f.service, (method, parameters) => {
      messages.push({ method, parameters });
      return Promise.resolve(null);
    }, bindings);
    // When moving through the trusted orchestration, not just the raw rename.
    await files.request("files.move", {
      path: "notes/B.md", to: "archive/C.md", version: b.version, updateLinks: true,
    }, caller());
    // Then unopened links, host save bindings and completion ordering all agree.
    eq(await Deno.readTextFile(join(f.root, "notes/A.md")),
      "[[/archive/C.md#Heading|Label]] [B.md](../archive/C.md)\r\n");
    eq(await Deno.readTextFile(join(f.root, "archive/C.md")), "# B\r\n");
    eq(bindings.has("notes/B.md"), false);
    eq(bindings.get("archive/C.md")?.version, b.version);
    eq(bindings.get("notes/A.md")?.version,
      (await api.files.stat({ path: "notes/A.md" })).version);
    eq(messages[0].method, "files.prepare");
    eq(messages.slice(-2).map((m) => m.method), ["files.commit", "files.finish"]);
    eq(files.changing, false);
  } finally {
    await f.close();
  }
});

Deno.test("a rejected workbench preparation leaves the filesystem untouched", async () => {
  const f = await fixture();
  try {
    // Given a destination draft collision reported by the real UI boundary.
    await Deno.writeTextFile(join(f.root, "a.txt"), "source");
    const stat = await f.api().files.stat({ path: "a.txt" });
    const methods: string[] = [];
    const files = coordinator(f.service, (method) => {
      methods.push(method);
      if (method === "files.prepare") return Promise.reject(new Error("draft collision"));
      return Promise.resolve(null);
    });
    // When the move is refused before the native operation.
    await rejects(() => files.request("files.move", {
      path: "a.txt", to: "b.txt", version: stat.version,
    }, caller()), /draft collision/);
    // Then source bytes survive and the workbench lock is released.
    eq(await Deno.readTextFile(join(f.root, "a.txt")), "source");
    await rejects(() => Deno.stat(join(f.root, "b.txt")), Deno.errors.NotFound);
    eq(methods, ["files.prepare", "files.finish"]);
    eq(files.changing, false);
  } finally {
    await f.close();
  }
});

Deno.test("workbench trash removes links to a deleted file in unopened notes", async () => {
  const f = await fixture();
  try {
    await Deno.writeTextFile(join(f.root, "A.md"),
      "[[B|Read B]] [code](src.ts) [web](https://example.com)\n");
    await Deno.writeTextFile(join(f.root, "B.md"), "# B\n");
    await Deno.writeTextFile(join(f.root, "src.ts"), "export const value = 1;\n");
    const version = (await f.api().files.stat({ path: "B.md" })).version;
    const files = coordinator(f.service, () => Promise.resolve(null));
    await files.request("files.trash", { path: "B.md", version }, caller());
    eq(await Deno.readTextFile(join(f.root, "A.md")),
      "Read B [code](src.ts) [web](https://example.com)\n");
  } finally {
    await f.close();
  }
});

Deno.test("a concurrent backlink edit is preserved and reported after the file move", async () => {
  const f = await fixture();
  try {
    // Given a link-update plan that becomes stale before the primary rename.
    await Deno.writeTextFile(join(f.root, "A.md"), "[[B]]");
    await Deno.writeTextFile(join(f.root, "B.md"), "# B");
    const version = (await f.api().files.stat({ path: "B.md" })).version;
    const receipts: Json[] = [];
    const files = coordinator(f.service, async (method, parameters) => {
      if (method === "files.paths") await Deno.writeTextFile(join(f.root, "A.md"), "external edit");
      if (method === "files.commit") receipts.push(parameters);
      return null;
    });
    // When the move commits but the backlink's version check fails.
    await files.request("files.move", { path: "B.md", to: "C.md", version }, caller());
    // Then the rename is not hidden and the external note is not overwritten.
    eq(await Deno.readTextFile(join(f.root, "A.md")), "external edit");
    eq(await Deno.readTextFile(join(f.root, "C.md")), "# B");
    const receipt = receipts.at(-1);
    ok(receipt && typeof receipt === "object" && !Array.isArray(receipt));
    eq(receipt.warningCount, 1);
    ok(Array.isArray(receipt.warnings) && String(receipt.warnings[0]).includes("A.md"));
  } finally {
    await f.close();
  }
});

Deno.test("file operations exclude overlapping requests while preparation is pending", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const timeout = AbortSignal.timeout(5000);
  const abort = () => entered.reject(timeout.reason);
  timeout.addEventListener("abort", abort, { once: true });
  try {
    // Given preparation subscribed before the first move starts.
    await Deno.writeTextFile(join(f.root, "a.txt"), "source");
    const version = (await f.api().files.stat({ path: "a.txt" })).version;
    const files = coordinator(f.service, async (method) => {
      if (method === "files.prepare") {
        entered.resolve();
        await release.promise;
      }
      return null;
    });
    const first = files.request("files.move", {
      path: "a.txt", to: "b.txt", version, updateLinks: false,
    }, caller());
    void first.catch((error) => entered.reject(error));
    await entered.promise;
    // When another mutation arrives before preparation completes.
    await rejects(() => files.request("files.trash", { path: "a.txt", version }, caller()),
      /current document operation/);
    release.resolve();
    await first;
    // Then exactly the first mutation has happened.
    eq(await Deno.readTextFile(join(f.root, "b.txt")), "source");
    eq((await f.api().files.trashList({})).entries, []);
  } finally {
    timeout.removeEventListener("abort", abort);
    release.resolve();
    await f.close();
  }
});
