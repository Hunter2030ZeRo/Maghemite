import { deepStrictEqual as eq, ok, rejects, throws } from "node:assert/strict";
import { NativeApplicationServices } from "../core/services/application.ts";
import { DesktopApplication } from "./application.ts";
import { createWorkbenchApplication } from "../../renderer/src/workspace/application.ts";
import {
  decodeSession,
  defaultLayout,
  documentFromText,
} from "../../renderer/src/workspace/model.ts";
import { fileURLToPath } from "node:url";
import { ATTACHMENT_LIMIT, createAttachments } from "../../renderer/src/workspace/attachments.ts";
import type { Json } from "../../modules-sdk/js/mod.ts";

Deno.test("workbench files are scoped to a stable workspace and stale bindings cannot resume", async () => {
  const temp = await Deno.makeTempDir(),
    root = `${temp}/workspace`,
    signal = new AbortController().signal;
  await Deno.mkdir(root);
  await Deno.writeTextFile(`${root}/a.txt`, "original");
  const options = {
    root,
    dataDirectory: `${temp}/data`,
    coreLibrary: fileURLToPath(
      new URL(
        "../../native/target/release/libmaghemite_core.so",
        import.meta.url,
      ),
    ),
  };
  const native = await NativeApplicationServices.open(options);
  try {
    const app = new DesktopApplication(native),
      id = await app.workspaceIdentity();
    ok(id && /^[a-f0-9]{64}$/.test(id));
    eq(await new DesktopApplication(native).workspaceIdentity(), id);
    const call = (name: string, p = {}) =>
      app.workbench(name, { ...p, workspaceId: id }, signal);
    const page = await call("files.list") as { entries: { name: string }[] };
    ok(page.entries.some((f) => f.name === "a.txt"));
    await rejects(
      () => app.workbench("files.list", { workspaceId: "wrong" }, signal),
      /Workspace changed/,
    );
    await rejects(() => call("files.stat", { path: "../private" }));
    const stat = await call("files.stat", { path: "a.txt" }) as {
      version: string;
    };
    await call("documents.resume", {
      path: "a.txt",
      diskVersion: stat.version,
    });
    await Deno.writeTextFile(`${root}/a.txt`, "external change");
    await rejects(
      () =>
        call("documents.resume", { path: "a.txt", diskVersion: stat.version }),
      /changed on disk/,
    );
    eq(await Deno.readTextFile(`${root}/a.txt`), "external change");
    await rejects(
      () => call("tools.start", { profile: "arbitrary" }),
      /Unsupported/,
    );
  } finally {
    await native.close();
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("workbench attachments use owned binary transfers without overwriting files", async () => {
  const temp = await Deno.makeTempDir(), root = `${temp}/workspace`;
  await Deno.mkdir(root);
  const native = await NativeApplicationServices.open({
    root, dataDirectory: `${temp}/data`,
    coreLibrary: fileURLToPath(new URL("../../native/target/release/libmaghemite_core.so", import.meta.url)),
  });
  const app = new DesktopApplication(native);
  try {
    const workspaceId = await app.workspaceIdentity(), signal = new AbortController().signal;
    const call = (method: string, parameters: Json = {}) => {
      if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
        throw new Error("Expected file operation parameters");
      }
      return app.workbench(method, { ...parameters, workspaceId }, signal);
    };
    const attachments = createAttachments(call), bytes = new Uint8Array(ATTACHMENT_LIMIT);
    bytes.set([0, 1, 255]);
    bytes[bytes.length - 1] = 128;
    const input = { name: "sample.png", size: bytes.length, type: "image/png",
      arrayBuffer: () => Promise.resolve(bytes.buffer) };
    const uploaded = await attachments.upload("Note.md", input);
    eq(new Uint8Array(await (await attachments.read(uploaded.path)).arrayBuffer()), bytes);
    await rejects(() => attachments.upload("Note.md", input));
    eq(await Deno.readFile(`${root}/${uploaded.path}`), bytes);
    const stat = await call("files.stat", { path: uploaded.path }) as { version: string };
    await rejects(() => call("files.beginWrite", {
      path: uploaded.path, version: stat.version,
    }), /new file/);
    const staged = await call("files.beginWrite", { path: "other.bin", version: null }) as { upload: string };
    const peer = new DesktopApplication(native);
    await rejects(() => peer.workbench("files.writeChunk", {
      workspaceId, upload: staged.upload, offset: 0, data: "AAH/",
    }, signal));
    await call("files.abortWrite", { upload: staged.upload });
    peer.close();
  } finally {
    app.close();
    await native.close();
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("explicit reload checks the editor version and preserves edits made during the disk read", () => {
  const document = documentFromText("a.md", "saved");
  const app = createWorkbenchApplication({
    documents: () => [document],
    active: () => ({ type: "document", documentId: document.id }),
    mode: () => "develop",
    edit: (_, text) => {
      app.changed(document.id);
      document.content = text;
    },
    saved: (_, text) => {
      document.savedContent = text;
    },
    bind: (_, version) => {
      document.diskVersion = version;
    },
    open() {},
    layout() {},
    notify() {},
    output() {},
  });
  const info = () =>
    (app.invoke(
      "documents.read",
      { id: document.id },
      "maghemite.workbench",
    ) as any).document;
  document.content = "dirty";
  const version = info().version;
  const stage = app.internal("stage.begin", { path: "a.md" }, "workbench") as {
    transfer: string;
  };
  app.internal(
    "stage.chunk",
    { ...stage, offset: 0, text: "disk" },
    "workbench",
  );
  app.changed(document.id);
  document.content = "typed while loading";
  throws(
    () =>
      app.internal(
        "stage.commit",
        { ...stage, replaceVersion: version },
        "workbench",
      ),
    /version conflict/,
  );
  eq(document.content, "typed while loading");
  const diskVersion = "a".repeat(64);
  app.internal("stage.commit", {
    ...stage,
    replaceVersion: info().version,
    diskVersion,
  }, "workbench");
  eq(document.content, "disk");
  eq(document.savedContent, "disk");
  eq(document.diskVersion, diskVersion);
});

Deno.test("recovery sessions retain disk identity, dirty content and the settings tab", () => {
  const doc = {
    ...documentFromText("a.md", "saved"),
    content: "unsaved",
    diskVersion: "a".repeat(64),
  };
  const session = {
    version: 1,
    documents: [doc],
    tabs: [{ id: "settings", type: "settings" }],
    activeTab: "settings",
    mode: "develop",
    layout: defaultLayout,
  };
  eq(decodeSession(JSON.stringify(session)), session);
  doc.diskVersion = "invalid";
  eq(decodeSession(JSON.stringify(session)), undefined);
});
