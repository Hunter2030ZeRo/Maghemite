import { deepStrictEqual as eq, ok, rejects, throws } from "node:assert/strict";
import { applicationRequest } from "./application.ts";
import { type AppMethod } from "../../../modules-sdk/js/app.ts";
import type { Json } from "../../../modules-sdk/js/mod.ts";
import { createHandler } from "../../desktop/main.ts";
import { DesktopApplication } from "../../desktop/application.ts";
import { ModuleHost } from "./host.ts";

import { fixture } from "./application_fixture.ts";

Deno.test("application broker: capability denial, discovery, validation and cancellation precede dispatch", async () => {
  const f = fixture(), signal = new AbortController().signal;
  const request = (method: string, parameters: Json, grants: string[] = []) =>
    applicationRequest(f.service, "test.app", new Set(grants), {
      method,
      parameters,
    }, signal);
  eq(await request("app.describe", {}), { version: 1, methods: [] });
  await rejects(
    () => request("documents.read", { id: "notes/A.md" }),
    /Capability denied/,
  );
  await rejects(
    () =>
      request("documents.applyEdit", {
        id: "notes/A.md",
        version: "old",
        from: 0,
        to: 1,
        text: "bad",
        moduleId: "other.app",
      }, ["documents.write"]),
    /Unknown API parameter/,
  );
  for (
    const name of [
      "constructor",
      "__proto__",
      "terminal.execute",
      "workspace.open",
    ]
  ) await rejects(() => request(name, {}), /Unsupported/);
  await rejects(
    () =>
      applicationRequest(undefined, "test.app", new Set(["documents.read"]), {
        method: "documents.read",
        parameters: { id: "notes/A.md" },
      }, signal),
    /unavailable/,
  );
  const abort = new AbortController();
  abort.abort();
  await rejects(
    () =>
      applicationRequest(f.service, "test.app", new Set(["documents.write"]), {
        method: "documents.applyEdit",
        parameters: {},
      }, abort.signal),
    DOMException,
  );
  const found = await request("app.describe", {}, ["documents.read"]) as {
    methods: string[];
  };
  eq(found.methods, ["workspace.search", "documents.list", "documents.read"]);
});

Deno.test("workbench adapter: real documents, UTF-16 versions, atomic edits, undo, knowledge and UI", () => {
  const f = fixture(),
    call = (name: AppMethod, params: Json = {}) =>
      f.app.invoke(name, params, "test.app") as Record<string, any>;
  const initial = call("documents.read", { id: "notes/A.md" });
  const edit = {
    id: "notes/A.md",
    version: initial.document.version,
    from: 0,
    to: 0,
    text: "# Added\n",
  };
  const changed = call("documents.applyEdit", edit);
  ok(changed.dirty);
  ok(changed.version !== initial.document.version);
  throws(() => call("documents.applyEdit", edit), /version conflict/);
  throws(
    () =>
      call("documents.read", { id: edit.id, version: edit.version, offset: 2 }),
    /version conflict/,
  );
  eq(f.documents[0].content, "# Added\n" + initial.text);
  f.app.undo();
  eq(f.documents[0].content, initial.text);
  const version = call("documents.read", { id: edit.id }).document.version;
  const emoji = f.documents[0].content.indexOf("🌍");
  throws(
    () =>
      call("documents.applyEdit", {
        ...edit,
        version,
        from: emoji + 1,
        to: emoji + 1,
      }),
    /Unicode/,
  );
  eq(
    call("knowledge.outline", { id: edit.id }).headings[0].text,
    "Alpha 한글 🌍",
  );
  eq(call("knowledge.backlinks", { id: edit.id }).sources, ["notes/B.md"]);
  eq(call("knowledge.graph").edges.length, 2);
  eq(
    call("workspace.search", { query: "answer" }).matches[0].id,
    "src/main.ts",
  );
  call("editor.open", { id: "src/main.ts" });
  eq(call("editor.getActive").documentId, "src/main.ts");
  call("ui.setPanel", { panel: "bottom", visible: true });
  eq(f.panels.bottom, true);
  call("output.append", { text: "output" });
  eq(f.events.at(-1), "[test.app] output");
  f.documents[0].content = "a".repeat(4095) + "🌍" + "b";
  f.app.changed(edit.id);
  const page = call("documents.read", { id: edit.id });
  eq(page.nextOffset, 4095);
  eq(
    call("documents.read", {
      id: edit.id,
      offset: page.nextOffset,
      version: page.document.version,
    }).text,
    "🌍b",
  );
  const latest = call("documents.read", { id: edit.id }).document.version;
  f.app.changed(edit.id);
  ok(call("documents.read", { id: edit.id }).document.version !== latest);
});

Deno.test("desktop API bootstrap rejects cross-origin requests, foreign hosts and missing secrets", async () => {
  const desktop = new DesktopApplication(),
    host = new ModuleHost({ application: desktop });
  const handler = createHandler(host, undefined, desktop);
  try {
    for (
      const request of [
        new Request("http://evil.test/api/workbench/session", {
          headers: { "X-Maghemite-Client": "1" },
        }),
        new Request("http://127.0.0.1:8000/api/workbench/session", {
          headers: { "Origin": "https://evil.test", "X-Maghemite-Client": "1" },
        }),
        new Request("http://127.0.0.1:8000/api/workbench/session"),
        new Request("http://127.0.0.1:8000/api/workbench/connect", {
          headers: {
            "Origin": "http://127.0.0.1:8000",
            "Upgrade": "websocket",
            "Sec-WebSocket-Protocol": "maghemite-v1, wrong",
          },
        }),
      ]
    ) {
      const response = await handler(request);
      eq(response.status, 403);
      await response.body?.cancel();
    }
    const response = await handler(
      new Request("http://127.0.0.1:8000/api/workbench/session", {
        headers: { "X-Maghemite-Client": "1" },
      }),
    );
    eq(response.status, 200);
    eq((await response.json()).token, desktop.token);
    eq(response.headers.get("Access-Control-Allow-Origin"), null);
  } finally {
    await host.close();
  }
});

Deno.test("workspace replacement invalidates document versions and releases module undo", () => {
  const f = fixture(), id = "notes/A.md";
  const first = f.app.documentVersion(id);
  f.app.invoke("documents.applyEdit", {
    id,
    version: first,
    from: 0,
    to: 0,
    text: "old workspace",
  }, "test.app");
  const beforeReset = f.app.documentVersion(id);
  f.app.resetDocuments();
  ok(f.app.documentVersion(id) !== beforeReset);
  const text = f.documents[0].content;
  f.app.undo();
  eq(f.documents[0].content, text);
  eq(f.events.at(-1), "No module edit to undo");
});
