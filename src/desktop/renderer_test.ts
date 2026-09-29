import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { ModuleHost } from "../modules/host/host.ts";
import { createHandler } from "./main.ts";

async function fixture() {
  const directory = await Deno.makeTempDir({ prefix: "maghemite-renderer-" });
  const host = new ModuleHost();
  return {
    directory,
    request: (path = "/", method = "GET") =>
      createHandler(host, directory)(
        new Request(`http://localhost${path}`, { method }),
      ),
    async close() {
      await host.close();
      await Deno.remove(directory, { recursive: true });
    },
  };
}

Deno.test("desktop serves the built index, typed assets and HEAD responses", async () => {
  const f = await fixture();
  try {
    const html = '<!doctype html><title>Maghemite</title><div id="root"></div>';
    await Deno.writeTextFile(`${f.directory}/index.html`, html);
    await Deno.mkdir(`${f.directory}/assets`);
    await Deno.writeTextFile(
      `${f.directory}/assets/app.js`,
      "export const app = 'Maghemite';",
    );
    await Deno.writeTextFile(
      `${f.directory}/assets/app.css`,
      "body { margin: 0; }",
    );
    const index = await f.request();
    strictEqual(index.status, 200);
    strictEqual(index.headers.get("content-type"), "text/html; charset=utf-8");
    strictEqual(await index.text(), html);
    for (
      const [extension, type] of [["js", "text/javascript"], [
        "css",
        "text/css",
      ]]
    ) {
      const asset = await f.request(`/assets/app.${extension}?v=1`);
      strictEqual(asset.status, 200);
      strictEqual(asset.headers.get("content-type"), `${type}; charset=utf-8`);
      strictEqual(asset.headers.get("x-content-type-options"), "nosniff");
      await asset.arrayBuffer();
    }
    const head = await f.request("/", "HEAD");
    strictEqual(head.status, 200);
    strictEqual(
      head.headers.get("content-length"),
      String(new TextEncoder().encode(html).length),
    );
    strictEqual(await head.text(), "");
  } finally {
    await f.close();
  }
});

Deno.test("missing build gives actionable guidance and becomes available after building", async () => {
  const f = await fixture();
  try {
    const missing = await f.request();
    strictEqual(missing.status, 503);
    match(await missing.text(), /deno task build/);
    await Deno.writeTextFile(`${f.directory}/index.html`, "built");
    strictEqual(await (await f.request()).text(), "built");
    strictEqual((await f.request("/assets/missing.js")).status, 404);
  } finally {
    await f.close();
  }
});

Deno.test("static serving rejects unsupported methods, hidden paths and symlink escapes", async () => {
  const f = await fixture();
  const secret = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(secret, "private source");
    await Deno.writeTextFile(`${f.directory}/.private`, "hidden");
    await Deno.symlink(secret, `${f.directory}/outside.js`);
    for (
      const path of [
        "/.private",
        "/outside.js",
        "/..%2fsecret",
        "/%5csecret",
        "/%00secret",
        "/assets",
      ]
    ) {
      strictEqual((await f.request(path)).status, 404, path);
    }
    strictEqual((await f.request("/%ZZ")).status, 400);
    const post = await f.request("/", "POST");
    strictEqual(post.status, 405);
    strictEqual(post.headers.get("allow"), "GET, HEAD");
  } finally {
    await f.close();
    await Deno.remove(secret);
  }
});

Deno.test("theme API remains available without a UI build; unknown API routes stay 404", async () => {
  const f = await fixture();
  try {
    const catalog = await f.request("/api/themes");
    strictEqual(catalog.status, 200);
    deepStrictEqual(await catalog.json(), { schemaVersion: 1, themes: [] });
    strictEqual((await f.request("/api/themes", "POST")).status, 405);
    strictEqual((await f.request("/api/missing")).status, 404);
  } finally {
    await f.close();
  }
});

Deno.test("CEF launch arguments retain spaces while removing duplicated suffixes", async () => {
  const { desktopArguments } = await import("./arguments.ts");
  const expected = [
    "--workspace=/tmp/My Notes",
    "--data-dir=/tmp/QA Data",
    "--port=0",
  ];
  if (
    JSON.stringify(
      desktopArguments(expected.map((_, i) => expected.slice(i).join(" "))),
    ) !== JSON.stringify(expected)
  ) throw new Error("CEF argv normalization failed");
  if (JSON.stringify(desktopArguments(expected)) !== JSON.stringify(expected)) {
    throw new Error("Ordinary argv changed");
  }
});
