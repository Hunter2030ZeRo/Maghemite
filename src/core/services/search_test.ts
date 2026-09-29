import { deepStrictEqual as eq, ok, rejects, throws } from "node:assert/strict";
import { join } from "node:path";
import { createAppAPI, validateAppRequest } from "../../../modules-sdk/js/app.ts";
import { DesktopApplication } from "../../desktop/application.ts";
import { collect, fixture } from "./search_fixture.ts";

Deno.test("trusted desktop search route exposes the same typed contract", async () => {
  const f = await fixture();
  try {
    // Given a native desktop workspace and an unopened file.
    await Deno.writeTextFile(join(f.root, "desktop.txt"), "needle");
    const desktop = new DesktopApplication(f.service);
    const workspaceId = await desktop.workspaceIdentity();
    const signal = AbortSignal.timeout(15000);
    const api = createAppAPI((method, parameters) => {
      if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
        throw new TypeError("Expected search parameters");
      }
      return desktop.workbench(method, { ...parameters, workspaceId }, signal);
    });
    // When searching and replacing through the trusted workbench allowlist.
    const { search, matches } = await collect(api, { query: "needle", replacement: "changed" });
    const result = await api.search.replace({ search, resultIds: [matches[0].id], skipPaths: [] });
    await api.search.release({ search });
    // Then both routing and the disk mutation are observable.
    eq(result.files[0].status, "applied");
    eq(await Deno.readTextFile(join(f.root, "desktop.txt")), "changed");
  } finally {
    await f.close();
  }
});

Deno.test("search SDK reads unopened UTF-16 matches with case, glob, ignore and symlink rules", async () => {
  const f = await fixture();
  try {
    // Given only disk files, never editor documents.
    await Deno.mkdir(join(f.root, "nested"));
    await Deno.mkdir(join(f.root, "node_modules"));
    await Deno.writeTextFile(join(f.root, ".gitignore"), "ignored.txt\n");
    for (
      const name of ["ignored.txt", "draft.txt", "node_modules/vendor.txt"]
    ) {
      await Deno.writeTextFile(join(f.root, name), "Needle");
    }
    await Deno.writeFile(
      join(f.root, "binary.txt"),
      new Uint8Array([78, 0, 101]),
    );
    await Deno.writeTextFile(
      join(f.root, "nested", "a.txt"),
      "😀é Needle\r\nneedle",
    );
    await Deno.symlink(
      join(f.root, "nested", "a.txt"),
      join(f.root, "link.txt"),
    );
    const api = f.api();
    // When going through the capability-checked typed SDK.
    const result = await collect(api, {
      query: "Needle",
      caseSensitive: true,
      include: ["*.txt"],
      skipPaths: ["draft.txt"],
    });
    // Then disk-only search has exact Unicode positions and the file service's hash.
    eq(result.matches.length, 1);
    const match = result.matches[0];
    eq([match.path, match.from, match.to, match.line, match.column], [
      "nested/a.txt",
      4,
      10,
      1,
      4,
    ]);
    eq(match.version, (await api.files.stat({ path: match.path })).version);
    await api.search.release({ search: result.search });
    const insensitive = await collect(api, {
      query: "needle",
      include: ["nested/*"],
    });
    eq(insensitive.matches.length, 2);
  } finally {
    await f.close();
  }
});

Deno.test("search SDK previews captures and replaces only selected original results", async () => {
  const f = await fixture();
  try {
    // Given an immutable replacement template and CRLF/Unicode text.
    await Deno.writeTextFile(join(f.root, "values.txt"), "a=12\r\nb=34😀\r\n");
    const api = f.api();
    const { search, matches } = await collect(api, {
      query: "(?P<key>[ab])=(\\d+)",
      regex: true,
      replacement: "${key}:$2/$$",
    });
    eq(matches[0].replacement, "a:12/$");
    // When replacing one selected result.
    const result = await api.search.replace({
      search,
      resultIds: [matches[0].id],
      skipPaths: [],
    });
    // Then the other match and original encoding are untouched.
    eq(result.files.map((file) => file.status), ["applied"]);
    eq(
      await Deno.readTextFile(join(f.root, "values.txt")),
      "a:12/$\r\nb=34😀\r\n",
    );
    eq(
      result.files[0].version,
      (await api.files.stat({ path: "values.txt" })).version,
    );
  } finally {
    await f.close();
  }
});

Deno.test("search SDK reports partial writes while preserving conflicts and current draft exclusions", async () => {
  const f = await fixture();
  try {
    // Given original search results across three files.
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      await Deno.writeTextFile(join(f.root, name), "needle");
    }
    const api = f.api();
    const { search, matches } = await collect(api, {
      query: "needle",
      replacement: "changed",
    });
    await Deno.writeTextFile(join(f.root, "b.txt"), "external");
    // When a disk version changed and the caller refreshes dirty exclusions.
    const result = await api.search.replace({
      search,
      resultIds: matches.map((m) => m.id),
      skipPaths: ["c.txt"],
    });
    // Then conflicts and draft exclusions are distinguishable from successful files.
    eq(result.files.map((file) => [file.path, file.status]), [
      ["a.txt", "applied"],
      ["b.txt", "conflict"],
      ["c.txt", "excluded"],
    ]);
    eq(await Deno.readTextFile(join(f.root, "b.txt")), "external");
    eq(await Deno.readTextFile(join(f.root, "c.txt")), "needle");
    ok(
      ![...Deno.readDirSync(f.root)].some((e) =>
        e.name.startsWith(".maghemite-write-")
      ),
    );
  } finally {
    await f.close();
  }
});

Deno.test("search SDK denies missing capabilities, forged options and other owners", async () => {
  const f = await fixture();
  try {
    // Given a valid owned result and several less privileged callers.
    await Deno.writeTextFile(join(f.root, "a.txt"), "needle");
    const api = f.api();
    const { search, matches } = await collect(api, {
      query: "needle",
      replacement: "changed",
    });
    const input = { search, resultIds: [matches[0].id], skipPaths: [] };
    // When they attempt operations outside their grants or ownership.
    await rejects(() => f.api("other").search.read({ search }), /owned/);
    await rejects(() => f.api("other").search.replace(input), /owned/);
    await rejects(
      () =>
        f.api("search-runtime", new Set(["files.read"])).search.replace(input),
      /files.write/,
    );
    await rejects(
      () =>
        f.api("search-runtime", new Set(["files.write"])).search.replace(input),
      /files.read/,
    );
    await rejects(
      () =>
        f.api("none", new Set(["documents.read"])).search.start({
          query: "needle",
        }),
      /files.read/,
    );
    throws(() =>
      validateAppRequest("search.start", { query: "needle", owner: "forged" })
    );
    await rejects(() => api.search.start({ query: "(", regex: true }), /regex/);
    await rejects(
      () =>
        api.search.replace({
          ...input,
          resultIds: [matches[0].id, matches[0].id],
        }),
      /Duplicate/,
    );
    const description = await f.api("write-only", new Set(["files.write"]))
      .describe();
    // Then discovery and dispatch agree, and no disk mutation occurred.
    ok(!description.methods.includes("search.replace"));
    eq(await Deno.readTextFile(join(f.root, "a.txt")), "needle");
  } finally {
    await f.close();
  }
});

Deno.test("search SDK bounds large previews and pages with explicit truncation", async () => {
  const f = await fixture();
  try {
    // Given a line larger than one SDK frame.
    await Deno.writeTextFile(join(f.root, "long.txt"), "a".repeat(60000));
    // When selecting a capped number of tiny matches with large replacements.
    const { matches, page } = await collect(f.api(), {
      query: "a",
      maxResults: 120,
      replacement: "b".repeat(2000),
    });
    // Then collect checked every serialized page and clipping is explicit.
    eq(matches.length, 120);
    eq(page.truncated, true);
    eq(matches[0].textTruncated, true);
    eq(matches[0].replacementTruncated, true);
  } finally {
    await f.close();
  }
});

Deno.test("search SDK cancellation and runtime release settle reads and dispose handles", async () => {
  const f = await fixture();
  try {
    // Given a large file and a read subscribed before cancellation.
    await Deno.writeTextFile(
      join(f.root, "large.txt"),
      "needle\n".repeat(100000),
    );
    const api = f.api();
    const { search } = await api.search.start({
      query: "needle",
      maxResults: 10000,
    });
    const pending = api.search.read({ search });
    // When cancelling, then releasing the runtime without waiting on a timer.
    await api.search.cancel({ search });
    await pending;
    let cursor = 0;
    for (;;) {
      const page = await api.search.read({ search, cursor });
      cursor = page.cursor;
      if (page.done) {
        eq(page.cancelled, true);
        break;
      }
    }
    await f.service.release("search-runtime");
    // Then none of the former owned handles are usable.
    await rejects(() => api.search.read({ search }), /owned/);
    const next = await api.search.start({ query: "absent" });
    await api.search.release(next);
    await rejects(() => api.search.read(next), /owned/);
  } finally {
    await f.close();
  }
});
