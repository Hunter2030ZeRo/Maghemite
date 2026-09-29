import { deepStrictEqual as eq, ok, rejects, throws } from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateAppRequest } from "../../../modules-sdk/js/app.ts";
import { fixture, indexed } from "./file_operations_fixture.ts";
import { collect } from "./search_fixture.ts";

Deno.test("file operation SDK moves versioned files and preserves legacy rename output", async () => {
  const f = await fixture();
  try {
    // Given a versioned executable and a capability-checked SDK.
    const api = f.api();
    await Deno.writeTextFile(join(f.root, "a"), "bytes");
    await Deno.chmod(join(f.root, "a"), 0o751);
    const { version } = await api.files.stat({ path: "a" });
    ok(version);
    // When moving then using the backward-compatible file rename method.
    eq(await api.files.move({ path: "a", to: "b", version }), {
      path: "a", to: "b", kind: "file", version,
    });
    eq(await api.files.rename({ path: "b", to: "c", version }), null);
    // Then the disk bytes and file mode survive both operations.
    eq(await Deno.readTextFile(join(f.root, "c")), "bytes");
    eq((await Deno.stat(join(f.root, "c"))).mode! & 0o777, 0o751);
    await rejects(() => Deno.stat(join(f.root, "a")), Deno.errors.NotFound);
  } finally { await f.close(); }
});

Deno.test("directory move SDK retains nested contents and directory modes", async () => {
  const f = await fixture();
  try {
    // Given a nonempty directory.
    await Deno.mkdir(join(f.root, "folder", "nested"), { recursive: true });
    await Deno.writeTextFile(join(f.root, "folder", "nested", "a"), "nested");
    await Deno.chmod(join(f.root, "folder"), 0o750);
    // When moving the directory with a null version.
    eq(await f.api().files.move({ path: "folder", to: "moved", version: null }), {
      path: "folder", to: "moved", kind: "directory", version: null,
    });
    // Then the entire directory tree and its mode remain intact.
    eq(await Deno.readTextFile(join(f.root, "moved", "nested", "a")), "nested");
    eq((await Deno.stat(join(f.root, "moved"))).mode! & 0o777, 0o750);
  } finally { await f.close(); }
});

Deno.test("SDK rejects stale versions collisions and unsafe paths without data loss", async () => {
  const f = await fixture();
  try {
    // Given source/destination files, symlinks, and a nested directory.
    const api = f.api();
    await Deno.writeTextFile(join(f.root, "a"), "original");
    const { version } = await api.files.stat({ path: "a" });
    await Deno.writeTextFile(join(f.root, "a"), "external source");
    await Deno.writeTextFile(join(f.root, "b"), "external destination");
    await Deno.mkdir(join(f.root, "dir", "child"), { recursive: true });
    await Deno.symlink(f.temporary, join(f.root, "outside"));
    await Deno.symlink("a", join(f.root, "link"));
    // When attempting stale mutations and all invalid move boundaries.
    await rejects(() => api.files.move({ path: "a", to: "new", version }), /version conflict/);
    await rejects(() => api.files.trash({ path: "a", version }), /version conflict/);
    const fresh = (await api.files.stat({ path: "a" })).version;
    for (const to of ["b", "../escaped", "/tmp/escaped", "outside/escaped", "a", ".maghemite-trash/x"]) {
      await rejects(() => api.files.move({ path: "a", to, version: fresh }));
    }
    await rejects(() => api.files.move({ path: "link", to: "new", version: fresh }));
    await rejects(() => api.files.trash({ path: "link", version: fresh }));
    await rejects(() => api.files.move({ path: "dir", to: "dir/child/new", version: null }));
    await rejects(() => api.files.move({ path: "", to: "new", version: null }));
    await rejects(() => api.files.move({ path: "dir", to: "new", version: fresh }));
    // Then rejected operations preserve both external versions and the tree.
    eq(await Deno.readTextFile(join(f.root, "a")), "external source");
    eq(await Deno.readTextFile(join(f.root, "b")), "external destination");
    ok((await Deno.stat(join(f.root, "dir", "child"))).isDirectory);
    await rejects(() => Deno.stat(join(f.temporary, "escaped")), Deno.errors.NotFound);
  } finally { await f.close(); }
});

Deno.test("trash SDK retains payload after restore collisions and supports an alternate path", async () => {
  const f = await fixture();
  try {
    // Given a trashed executable and a recreated original destination.
    const api = f.api();
    await Deno.writeTextFile(join(f.root, "a"), "recoverable");
    await Deno.chmod(join(f.root, "a"), 0o711);
    const { version } = await api.files.stat({ path: "a" });
    const trashed = await api.files.trash({ path: "a", version });
    await Deno.writeTextFile(join(f.root, "a"), "external");
    await Deno.symlink(f.temporary, join(f.root, "outside"));
    // When restoring to occupied, outside, and reserved paths.
    for (const to of [undefined, "../escaped", "outside/escaped", ".maghemite-trash/escaped"]) {
      await rejects(() => api.files.restoreTrash({ id: trashed.id, ...(to ? { to } : {}) }));
    }
    // Then the payload remains listed until restored to an unoccupied path.
    eq(await Deno.readTextFile(join(f.root, "a")), "external");
    eq((await api.files.trashList({})).entries.map((e) => e.id), [trashed.id]);
    eq(await api.files.restoreTrash({ id: trashed.id, to: "restored" }), {
      path: "restored", kind: "file", version,
    });
    eq(await Deno.readTextFile(join(f.root, "restored")), "recoverable");
    eq((await Deno.stat(join(f.root, "restored"))).mode! & 0o777, 0o711);
    eq((await api.files.trashList({})).entries, []);
  } finally { await f.close(); }
});

Deno.test("trash IDs and directory contents survive an actual process restart", async () => {
  // Given two independent Deno processes using the same unique fixture.
  const temporary = await Deno.makeTempDir({ prefix: "maghemite-trash-restart-" });
  const fixturePath = fileURLToPath(new URL("./file_operations_fixture.ts", import.meta.url));
  const run = async (mode: string) => {
    const output = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-read", "--allow-write", "--allow-env", "--allow-ffi", fixturePath, mode, temporary],
      stdout: "piped", stderr: "piped",
    }).output();
    eq(output.code, 0, new TextDecoder().decode(output.stderr));
    return JSON.parse(new TextDecoder().decode(output.stdout));
  };
  try {
    // When trash is written by one process and restored by a fresh process.
    const trashed = await run("trash");
    const restored = await run("restore");
    // Then the durable recovery ID and original directory path agree.
    eq(restored.id, trashed.id);
    eq(restored.path, "folder");
  } finally { await Deno.remove(temporary, { recursive: true }); }
});

Deno.test("trash listing SDK pages deterministic IDs and applies explicit capabilities", async () => {
  const f = await fixture();
  try {
    // Given more recoverable entries than one page.
    const api = f.api();
    const ids: string[] = [];
    for (let n = 0; n < 23; n++) {
      const path = `file-${n}`;
      await Deno.writeTextFile(join(f.root, path), `bytes-${n}`);
      const { version } = await api.files.stat({ path });
      ids.push((await api.files.trash({ path, version })).id);
    }
    const read = f.api(new Set(["files.read"]));
    const write = f.api(new Set(["files.write"]));
    // When listing pages as a read-only caller.
    const first = await read.files.trashList({});
    const second = await read.files.trashList({ offset: first.nextOffset! });
    eq(first.entries.length, 20);
    eq(second.entries.length, 3);
    eq(second.nextOffset, null);
    eq([...first.entries, ...second.entries].map((e) => e.id), ids.sort());
    // Then capability discovery and mutation checks agree, without extra read grants.
    await rejects(() => read.files.restoreTrash({ id: ids[0] }), /files.write/);
    await rejects(() => read.files.move({ path: "x", to: "y", version: null }), /files.write/);
    await rejects(() => read.files.trash({ path: "x", version: null }), /files.write/);
    await rejects(() => write.files.trashList({}), /files.read/);
    const description = await write.describe();
    ok(description.methods.includes("files.restoreTrash"));
    ok(!description.methods.includes("files.trashList"));
    const restored = await write.files.restoreTrash({ id: ids[0], to: "write-only" });
    eq(restored.path, "write-only");
    await write.files.move({ path: "write-only", to: "moved", version: restored.version });
    await write.files.trash({ path: "moved", version: restored.version });
    throws(() => validateAppRequest("files.restoreTrash", { id: "../bad" }));
    throws(() => validateAppRequest("files.move", { path: "a", to: "b" }));
    throws(() => validateAppRequest("files.trashList", { offset: -1 }));
  } finally { await f.close(); }
});

Deno.test("trash pagination bounds escaped paths within the native response budget", async () => {
  const f = await fixture();
  try {
    // Given valid long paths whose JSON escaping expands beyond a fixed 20-entry page.
    const api = f.api();
    const parent = Array.from({ length: 9 }, () => "\x01".repeat(100)).join("/");
    await Deno.mkdir(join(f.root, parent), { recursive: true });
    const ids: string[] = [];
    for (let n = 0; n < 12; n++) {
      const path = `${parent}/file-${n}`;
      await Deno.writeTextFile(join(f.root, path), "bounded");
      const { version } = await api.files.stat({ path });
      ids.push((await api.files.trash({ path, version })).id);
    }
    // When reading every page through the native FFI response boundary.
    const listed: string[] = [];
    let offset: number | undefined;
    do {
      const page = await api.files.trashList(offset === undefined ? {} : { offset });
      ok(new TextEncoder().encode(JSON.stringify(page)).length < 48 * 1024);
      listed.push(...page.entries.map((entry) => entry.id));
      offset = page.nextOffset ?? undefined;
    } while (offset !== undefined);
    // Then every recoverable ID is reachable exactly once.
    eq(listed, ids.sort());
  } finally { await f.close(); }
});

Deno.test("reserved trash is excluded from listing search and full and incremental indexing", async () => {
  const f = await fixture();
  try {
    // Given a trashed file containing searchable symbols.
    let api = f.api();
    await Deno.writeTextFile(join(f.root, "hidden.ts"), "export function trashNeedle() { return 42; }\n");
    const { version } = await api.files.stat({ path: "hidden.ts" });
    const trashed = await api.files.trash({ path: "hidden.ts", version });
    await f.restart();
    api = f.api();
    await indexed(api);
    // When using explorer, search, and a fresh native index.
    const listed = await api.files.list({});
    const searched = await collect(api, { query: "trashNeedle" });
    const files = await api.index.query({ kind: "files", query: ".maghemite-trash" });
    const symbols = await api.index.query({ kind: "symbols", query: "trashNeedle" });
    // Then none of the surfaces exposes the internal storage.
    ok(listed.entries.every((entry) => entry.name !== ".maghemite-trash"));
    eq(searched.matches, []);
    eq(files.items, []);
    eq(symbols.items, []);
    await api.search.release({ search: searched.search });
    // A watch-triggering metadata change must also stay absent from the index.
    const { subscription } = await api.events.subscribe({ topics: ["index.changed"] });
    const next = api.events.next({ subscription, waitMs: 15000 });
    await Deno.utime(join(f.root, ".maghemite-trash", trashed.id, "payload"), 1, 1);
    let page = await next;
    for (;;) {
      ok(page.events.length > 0, "incremental index completion deadline");
      if (page.events.some((e) => e.data && typeof e.data === "object" &&
        !Array.isArray(e.data) && e.data.phase === "completed")) break;
      page = await api.events.next({ subscription, waitMs: 15000 });
    }
    await api.events.unsubscribe({ subscription });
    eq((await api.index.query({ kind: "files", query: ".maghemite-trash" })).items, []);
  } finally { await f.close(); }
});

Deno.test("reserved trash protection rejects direct paths aliases corruption and unowned adoption", async () => {
  const f = await fixture();
  try {
    // Given a recoverable file and symlink aliases to its internal storage.
    const api = f.api();
    await Deno.writeTextFile(join(f.root, "a"), "protected");
    const { version } = await api.files.stat({ path: "a" });
    const { id } = await api.files.trash({ path: "a", version });
    await Deno.symlink(".maghemite-trash", join(f.root, "alias"));
    // When attempting ordinary SDK APIs through direct and aliased paths.
    for (const prefix of [".maghemite-trash", "alias"]) {
      const path = `${prefix}/${id}/payload`;
      await rejects(() => api.files.read({ path }));
      await rejects(() => api.files.stat({ path }));
      await rejects(() => api.files.list({ path: `${prefix}/${id}` }));
      await rejects(() => api.files.beginWrite({ path, version }));
      await rejects(() => api.files.remove({ path, version }));
      await rejects(() => api.files.mkdir({ path: `${prefix}/new` }));
      await rejects(() => api.files.move({ path, to: "stolen", version }));
    }
    const metadata = join(f.root, ".maghemite-trash", id, "metadata.json");
    const record = JSON.parse(await Deno.readTextFile(metadata));
    record.path = "../escaped";
    await Deno.writeTextFile(metadata, JSON.stringify(record));
    await rejects(() => api.files.restoreTrash({ id }));
    // Then corrupt metadata cannot direct an operation outside the workspace.
    eq(await Deno.readTextFile(join(f.root, ".maghemite-trash", id, "payload")), "protected");
    await rejects(() => Deno.stat(join(f.temporary, "escaped")), Deno.errors.NotFound);
  } finally { await f.close(); }

  const unowned = await fixture();
  try {
    // Given storage created externally without a trusted ownership receipt.
    await Deno.mkdir(join(unowned.root, ".maghemite-trash"));
    await Deno.writeTextFile(join(unowned.root, "a"), "keep");
    const api = unowned.api();
    const { version } = await api.files.stat({ path: "a" });
    // When attempting to adopt that directory for trash.
    await rejects(() => api.files.trash({ path: "a", version }), /Unowned/);
    // Then the source remains intact.
    eq(await Deno.readTextFile(join(unowned.root, "a")), "keep");
  } finally { await unowned.close(); }
});
