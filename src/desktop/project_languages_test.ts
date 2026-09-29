/// <reference lib="dom" />
import { deepStrictEqual as eq, ok, rejects, throws } from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Json } from "../../modules-sdk/js/mod.ts";
import { projectRecord, applyLanguageEdits } from "../../modules-sdk/js/project.ts";
import { ModuleHost } from "../modules/host/host.ts";
import { fixture } from "../core/services/file_operations_fixture.ts";
import { DesktopApplication } from "./application.ts";
import { createWorkbenchApplication } from "../../renderer/src/workspace/application.ts";
import { documentFromText, type WorkspaceDocument } from "../../renderer/src/workspace/model.ts";
import { prepareProjectDocuments } from "../../renderer/src/editors/project_documents.ts";
import { EditorText } from "../../renderer/src/editors/text.ts";
import { projectLanguageFixture as data } from "./fixtures/project-language/main.ts";
import type { EditorLanguageEdit, EditorLanguageLocation } from "../../renderer/src/editors/protocol.ts";
import { ProjectLanguages } from "./project_languages.ts";
import { validateLanguageResult } from "./languages.ts";

async function connected() {
  const disk = await fixture();
  await Deno.writeTextFile(join(disk.root, data.main.path), data.main.text);
  await Deno.writeTextFile(join(disk.root, data.target.path), data.target.text);
  const documents: WorkspaceDocument[] = [documentFromText(data.main.path, data.main.text)];
  let active = data.main.path as string;
  let selection: { id: string; anchor: number; head: number } | undefined;
  let before: (method: string, parameters: Record<string, Json>) => Promise<void> = () => Promise.resolve();
  const app = createWorkbenchApplication({
    documents: () => documents,
    active: () => ({ type: "document", documentId: active }),
    mode: () => "develop",
    edit(id, text) {
      const document = documents.find((d) => d.id === id);
      if (!document) throw new Error("Missing editor document");
      document.content = text;
      app.changed(id);
    },
    create: (d) => { documents.push(d); },
    saved: (id, text) => { const d = documents.find((d) => d.id === id); if (d) d.savedContent = text; },
    bind: (id, version) => { const d = documents.find((d) => d.id === id); if (d) d.diskVersion = version; },
    open: (id) => { active = id; },
    select: (id, anchor, head) => { selection = { id, anchor, head }; },
    layout() {},
    notify() {},
    output() {},
  });
  const desktop = new DesktopApplication(disk.service);
  const host = new ModuleHost({ application: desktop });
  await host.register(fileURLToPath(new URL("./fixtures/project-language/", import.meta.url)),
    ["documents.read", "files.read"]);
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => desktop.connect(request, host));
  const socket = new WebSocket(`ws://127.0.0.1:${server.addr.port}`, "maghemite-v1");
  const requests = new Set<Promise<void>>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type !== "request") return;
    const response = (value: Json, error?: unknown) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
        type: "result", id: message.id, ok: error === undefined,
        ...(error === undefined ? { value } : { error: String(error) }),
      }));
    };
    const work = (async () => {
      try {
        await before(message.method, message.parameters);
        const value = message.internal
          ? app.internal(message.method, message.parameters, message.owner)
          : app.invoke(message.method, message.parameters, message.moduleId, message.owner);
        response(value);
      } catch (error) {
        response(null, error);
      }
    })();
    requests.add(work);
    void work.finally(() => requests.delete(work));
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Fixture WebSocket failed")), { once: true });
  });
  const workspaceId = await desktop.workspaceIdentity();
  const call = (method: string, parameters: Record<string, Json>, signal = AbortSignal.timeout(10000)) =>
    desktop.workbench(method, { ...parameters, workspaceId }, signal);
  const query = async (method: string, extra: Record<string, Json> = {}) => {
    const response = await call("languages.request", {
      id: data.main.path, version: app.documentVersion(data.main.path), method,
      offset: documents[0].content.indexOf("item"), ...extra,
    });
    return projectRecord(response).result;
  };
  return {
    disk, documents, app, host, desktop, call, query,
    selected: () => selection,
    active: () => active,
    intercept: (hook: typeof before) => { before = hook; },
    async close() {
      desktop.close();
      await desktop.settle();
      await host.close();
      const closed = socket.readyState === WebSocket.CLOSED
        ? Promise.resolve()
        : new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }));
      socket.close();
      await closed;
      await server.shutdown();
      await Promise.all(requests);
      await disk.close();
    },
  };
}

Deno.test("project module locations reach actual unopened editor documents through desktop routing", async () => {
  const f = await connected();
  try {
    // Given a real module and an unopened CRLF/Unicode disk target.
    const definitions = await f.query("definition") as EditorLanguageLocation[];
    const references = await f.query("references", { includeDeclaration: true }) as EditorLanguageLocation[];
    eq(references.map((r) => r.path), [data.main.path, data.target.path]);
    eq((await f.query("references", { includeDeclaration: false }) as unknown[]).length, 1);
    const target = definitions[0];
    eq(target.selection, { start: { line: 2, column: 8 }, end: { line: 2, column: 12 } });
    eq(target.version.kind, "disk");
    // When the public editor opener sends its actual versioned location contract.
    await f.call("languages.open", {
      proposal: target.proposal, path: target.path, from: target.range.from, to: target.range.to,
    });
    // Then the selected editor document has real content and original offsets.
    eq(f.documents[1].content, data.target.text);
    eq(f.active(), data.target.path);
    eq(f.selected(), { id: data.target.path, anchor: data.target.text.indexOf("item"), head: data.target.text.indexOf("item") + 4 });
  } finally { await f.close(); }
});

Deno.test("project rename edits dirty and unopened drafts atomically with shared undo and disk save binding", async () => {
  const f = await connected();
  try {
    // Given an unsaved source and a disk-only target.
    f.documents[0].content += "// unsaved\r\n";
    f.app.changed(data.main.path);
    const original = f.documents[0].content;
    const edit = await f.query("rename", { newName: "renamed" }) as EditorLanguageEdit;
    eq(edit.documents.map((d) => d.version.kind), ["document", "disk"]);
    // When the bulk-edit service submits the real provider proposal.
    const applied = await f.call("languages.apply", { proposal: edit.proposal });
    eq(projectRecord(applied).applied, 2);
    // Then both actual documents changed together and one shared undo restores both.
    eq(f.documents.map((d) => d.content), [
      original.replace("item", "renamed"), data.target.text.replace("item", "renamed"),
    ]);
    eq(await Deno.readTextFile(join(f.disk.root, data.target.path)), data.target.text);
    f.app.undo();
    eq(f.documents.map((d) => d.content), [original, data.target.text]);
    ok(f.documents[1].diskVersion);
    await f.call("documents.save", { id: data.target.path, version: f.app.documentVersion(data.target.path) });
    eq(await Deno.readTextFile(join(f.disk.root, data.target.path)), data.target.text);
  } finally { await f.close(); }
});

Deno.test("project rename uses an open dirty target instead of its older disk text", async () => {
  const f = await connected();
  try {
    // Given a dirty target with a different line layout from the disk version.
    const target = documentFromText(data.target.path, data.target.text);
    target.content = "// dirty 😀\r\n" + target.content;
    f.documents.push(target);
    const before = target.content;
    // When the module resolves and renames using the dirty overlay.
    const edit = await f.query("rename", { newName: "changed" }) as EditorLanguageEdit;
    eq(edit.documents[1].version.kind, "document");
    eq(edit.documents[1].edits[0].selection.start, { line: 3, column: 8 });
    await f.call("languages.apply", { proposal: edit.proposal });
    // Then original overlay offsets are used and saved disk identity is untouched.
    eq(target.content, before.replace("item", "changed"));
    eq(target.savedContent, data.target.text);
    eq(await Deno.readTextFile(join(f.disk.root, data.target.path)), data.target.text);
  } finally { await f.close(); }
});

for (const conflict of ["dirty", "unopened", "opened", "during-stage"] as const) {
  Deno.test(`project rename makes no partial changes on ${conflict} version conflict`, async () => {
    const f = await connected();
    try {
      // Given a fully validated module proposal.
      const edit = await f.query("rename", { newName: "changed" }) as EditorLanguageEdit;
      if (conflict === "dirty") {
        f.documents[0].content += "user edit";
        f.app.changed(data.main.path);
      } else if (conflict === "unopened") {
        await Deno.writeTextFile(join(f.disk.root, data.target.path), "external");
      } else if (conflict === "opened") {
        f.documents.push(documentFromText(data.target.path, data.target.text));
      } else {
        let changed = false;
        f.intercept(async (method) => {
          if (method === "project.chunk" && !changed) {
            changed = true;
            await Deno.writeTextFile(join(f.disk.root, data.target.path), "external during stage");
          }
        });
      }
      const before = f.documents.map((d) => ({ ...d }));
      // When the stale proposal reaches the apply entry point.
      await rejects(() => f.call("languages.apply", { proposal: edit.proposal }), /conflict|changed/i);
      // Then no target was opened or partially modified.
      eq(f.documents, before);
    } finally { await f.close(); }
  });
}

Deno.test("project completion additional edits preserve original CRLF and Unicode at the editor seam", async () => {
  const f = await connected();
  try {
    // Given the module's real completion result in original-source coordinates.
    const items = await f.query("completion") as {
      range: { from: number; to: number }; insertText: string;
      additionalTextEdits: { range: { from: number; to: number }; text: string }[];
    }[];
    const item = items[0], text = new EditorText(f.documents[0].content);
    // When the editor applies the suggestion and its additional edits together.
    text.apply([{ ...item.range, text: item.insertText },
      ...item.additionalTextEdits.map((e) => ({ ...e.range, text: e.text }))]);
    // Then the import is inserted without disturbing the Unicode prefix or CRLF.
    eq(text.text, "// 프로젝트 😀\r\n" + data.importText + "\r\nitem\r\n");
    eq(applyLanguageEdits(data.main.text, [
      ...item.additionalTextEdits, { range: item.range, text: item.insertText },
    ]), text.text);
  } finally { await f.close(); }
});

Deno.test("project cancellation discards the pending editor result before document mutation", async () => {
  const f = await connected();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  try {
    // Given a request gated on a real reverse-RPC snapshot read.
    f.intercept(async (method) => {
      if (method === "snapshot.begin") { entered.resolve(); await release.promise; }
    });
    const work = f.query("rename", { newName: "changed", requestId: "cancel-test" });
    const rejected = rejects(work, /cancel/i);
    await Promise.race([entered.promise, work.then(() => { throw new Error("Gate was not reached"); })]);
    // When the actual editor cancellation route cancels the owned request.
    await f.call("languages.cancel", { requestId: "cancel-test" });
    release.resolve();
    await rejected;
    // Then no proposal was applied and the editor retains its exact source.
    eq(f.documents.map((d) => d.content), [data.main.text]);
  } finally { release.resolve(); await f.close(); }
});

Deno.test("project results are rejected when drafts change during result validation", async () => {
  const f = await connected();
  try {
    // Given a real module result whose source changes before validation completes.
    let contexts = 0;
    f.intercept((method) => {
      if (method === "project.context" && ++contexts === 2) {
        f.documents[0].content += "new input";
        f.app.changed(data.main.path);
      }
      return Promise.resolve();
    });
    // When the pending definition returns.
    await rejects(() => f.query("definition"), /Project changed/);
    // Then it has no authority to open a stale target.
    eq(f.documents.length, 1);
    eq(f.documents[0].content, data.main.text + "new input");
  } finally { await f.close(); }
});

Deno.test("project proposals lose authority when their module is unregistered", async () => {
  const f = await connected();
  try {
    // Given a valid proposal from an installed module.
    const edit = await f.query("rename", { newName: "changed" }) as EditorLanguageEdit;
    await f.host.unregister("test.project-language");
    // When a retained Monaco proposal is applied after provider removal.
    await rejects(() => f.call("languages.apply", { proposal: edit.proposal }), /provider changed/i);
    // Then neither the dirty source nor unopened target changes.
    eq(f.documents.map((d) => d.content), [data.main.text]);
  } finally { await f.close(); }
});

Deno.test("protocol one completion cannot smuggle unvalidated additional edits", () => {
  // Given a legacy completion result with a protocol-two-only field.
  const item = {
    label: "x", insertText: "x", detail: "", filterText: "x",
    range: { from: 0, to: 1 },
    additionalTextEdits: [{ range: { from: -1, to: 999 }, text: "bad" }],
  };
  // When it reaches the unchanged legacy result boundary.
  throws(() => validateLanguageResult("completion", [item], 4, "file.fixture"),
    /protocol 2/);
});

Deno.test("project invalid outside paths are rejected before any file access", async () => {
  // Given an untrusted version-2 module response.
  let reads = 0;
  const projects = new ProjectLanguages();
  // When a dependency attempts to escape the workspace.
  await rejects(() => projects.accept({
    reads: [{ path: "../outside", version: { kind: "disk", value: "v" } }],
    result: [],
  }, "definition", data.main.path, "v", "provider", { id: "w", revision: "r" }, {
    context: () => Promise.resolve({ id: "w", revision: "r" }),
    read() { reads++; throw new Error("Unexpected file access"); },
    commit() { throw new Error("Unexpected commit"); },
  }, new AbortController().signal, () => {}), /confined/);
  // Then no path reached the filesystem capability.
  eq(reads, 0);
});

Deno.test("project document preparation rejects broken Unicode and CRLF before any changes", () => {
  const d = documentFromText("main.fixture", "😀\r\nitem");
  const version = { kind: "document", value: "v" };
  for (const from of [1, 3]) {
    // Given a malformed proposal whose later range bisects a character or CRLF.
    const payload = {
      revision: "r",
      edit: { documents: [{ path: d.path, version, edits: [
        { range: { from, to: from }, text: "bad" },
      ] }] },
      snapshots: [{ path: d.path, version, text: d.content }],
    };
    // When the real renderer transaction boundary prepares it.
    throws(() => prepareProjectDocuments(payload, [d], () => "v", "r"), /Unicode|CRLF/);
    // Then the shared document has never changed.
    eq(d.content, "😀\r\nitem");
  }
});
