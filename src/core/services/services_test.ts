import { deepStrictEqual as eq, ok, rejects, throws } from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NativeApplicationServices } from "./application.ts";
import {
  APP_METHODS,
  type AppMethod,
  validateAppRequest,
} from "../../../modules-sdk/js/app.ts";
import { SERVICE_METHODS } from "../../../modules-sdk/js/services.ts";
import {
  type ApplicationCaller,
  applicationRequest,
} from "../../modules/host/application.ts";
import type { Json } from "../../../modules-sdk/js/mod.ts";
import { createWorkbenchApplication } from "../../../renderer/src/workspace/application.ts";
import { documentFromText } from "../../../renderer/src/workspace/model.ts";
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const coreLibrary = fileURLToPath(
  new URL(
    "../../../native/target/release/libmaghemite_core.so",
    import.meta.url,
  ),
);
const fixture = fileURLToPath(
  new URL("./protocol_fixture.ts", import.meta.url),
);
Deno.test("native services: scoped files, uploads, index, persistence, events, tools and protocol sessions", async () => {
  const temp = await Deno.makeTempDir({ prefix: "maghemite-services-" }),
    root = join(temp, "workspace"),
    data = join(temp, "data");
  await Deno.mkdir(root);
  await Deno.writeTextFile(
    join(root, "source.ts"),
    "export function answer() { return 42; }\n",
  );
  await Deno.writeTextFile(join(temp, "outside"), "secret");
  await Deno.symlink(join(temp, "outside"), join(root, "escape"));
  const service = await NativeApplicationServices.open({
    root,
    dataDirectory: data,
    coreLibrary,
    profiles: [
      { id: "echo", kind: "tool", command: "/bin/cat" },
      { id: "format", kind: "formatter", command: "/bin/cat" },
      { id: "lint", kind: "linter", command: "/bin/cat" },
      {
        id: "lsp",
        kind: "language",
        command: Deno.execPath(),
        args: ["run", fixture],
      },
      {
        id: "dap",
        kind: "debug",
        command: Deno.execPath(),
        args: ["run", fixture, "dap"],
      },
    ],
  });
  const caller: ApplicationCaller = {
    moduleId: "test.services",
    owner: "runtime-one",
    grants: new Set([...Object.values(APP_METHODS), "process.execute"]),
    signal: new AbortController().signal,
  };
  const call = (method: AppMethod, p: Json = {}, who = caller) =>
    applicationRequest(
      service,
      who.moduleId,
      who.grants!,
      { method, parameters: p },
      who.signal,
      who.owner,
    ) as Promise<any>;
  try {
    eq((await call("workspace.roots")).roots.length, 1);
    ok(
      (await call("files.list")).entries.some((e: any) =>
        e.name === "source.ts"
      ),
    );
    const original = await call("files.read", { path: "source.ts" });
    ok(atob(original.data).includes("answer"));
    eq(
      (await call("files.stat", { path: "source.ts" })).version,
      original.version,
    );
    for (const path of ["../outside", "/etc/passwd", "escape"]) {
      await rejects(() => call("files.read", { path }));
    }
    const upload =
      (await call("files.beginWrite", { path: "new.txt", version: null }))
        .upload;
    await rejects(
      () =>
        call("files.writeChunk", { upload, offset: 0, data: btoa("no") }, {
          ...caller,
          owner: "runtime-two",
        }),
      /owned/,
    );
    await call("files.writeChunk", {
      upload,
      offset: 0,
      data: btoa("new content"),
    });
    const written = await call("files.commitWrite", { upload });
    eq(await Deno.readTextFile(join(root, "new.txt")), "new content");
    const stale = (await call("files.beginWrite", {
      path: "new.txt",
      version: written.version,
    })).upload;
    await Deno.writeTextFile(join(root, "new.txt"), "external change");
    await rejects(
      () => call("files.commitWrite", { upload: stale }),
      /version conflict/,
    );
    eq(await Deno.readTextFile(join(root, "new.txt")), "external change");
    const fresh = await call("files.stat", { path: "new.txt" });
    await call("files.rename", {
      path: "new.txt",
      to: "renamed.txt",
      version: fresh.version,
    });
    await call("files.remove", { path: "renamed.txt", version: fresh.version });
    await call("files.mkdir", { path: "folder" });
    await call("files.remove", { path: "folder", version: null });
    const sub = await call("events.subscribe", {
      topics: ["settings.changed"],
    });
    const event = call("events.next", {
      subscription: sub.subscription,
      waitMs: 1000,
    });
    const setting = await call("settings.set", {
      key: "font",
      value: "Mono",
      version: null,
    });
    eq((await event).events[0].topic, "settings.changed");
    eq((await call("settings.get", { key: "font" })).value, "Mono");
    await rejects(
      () => call("settings.set", { key: "font", value: "Bad", version: null }),
      /conflict/,
    );
    eq((await call("settings.keys")).keys, ["font"]);
    eq(
      (await call("settings.get", { key: "font" }, {
        ...caller,
        moduleId: "other.module",
      })).value,
      null,
    );
    await call("events.unsubscribe", { subscription: sub.subscription });
    const stored = await call("storage.set", {
      key: "cache",
      value: { hello: 42 },
      version: null,
    });
    eq((await call("storage.get", { key: "cache" })).value, { hello: 42 });
    await call("storage.delete", { key: "cache", version: stored.version });
    const tool = await call("tools.start", {
      profile: "echo",
      input: "actual stdin\n",
    });
    let output;
    for (let i = 0; i < 100; i++) {
      output = await call("tools.read", { session: tool.session });
      if (output.done) break;
      await pause(10);
    }
    eq(output.text, "actual stdin\n");
    eq(output.exitCode, 0);
    await call("tools.stop", { session: tool.session });
    eq(
      (await call("formatting.format", {
        profile: "format",
        text: "format me",
      })).stdout,
      "format me",
    );
    eq(
      (await call("linting.lint", { profile: "lint", text: "lint me" }))
        .exitCode,
      0,
    );
    for (const kind of ["language", "debug"] as const) {
      const session = await call(`${kind}.start`, {
        profile: kind === "language" ? "lsp" : "dap",
      });
      eq(
        (await call(`${kind}.request`, {
          session: session.session,
          method: "echo",
          parameters: { hello: 42 },
        })).echo,
        { hello: 42 },
      );
      await rejects(
        () =>
          call(`${kind}.read`, { session: session.session }, {
            ...caller,
            owner: "other-runtime",
          }),
        /owned/,
      );
      if (kind === "language") {
        await call("language.sync", {
          session: session.session,
          path: "source.ts",
          languageId: "typescript",
          version: 1,
          text: "a",
        });
        await rejects(
          () =>
            call("language.sync", {
              session: session.session,
              path: "source.ts",
              languageId: "typescript",
              version: 1,
              text: "b",
            }),
          /version conflict/,
        );
        await pause(30);
        ok(
          (await call("language.read", { session: session.session })).messages
            .length > 0,
        );
        await call("language.closeDocument", {
          session: session.session,
          path: "source.ts",
        });
      }
      await call(`${kind}.request`, {
        session: session.session,
        method: "ask",
        parameters: {},
      });
      const messages =
        (await call(`${kind}.read`, { session: session.session })).messages;
      ok(
        messages.some((m: any) =>
          kind === "debug"
            ? m.message.type === "request"
            : m.message.id === "server-1"
        ),
      );
      await call(`${kind}.respond`, {
        session: session.session,
        requestId: kind === "debug" ? 999 : "server-1",
        result: { accepted: true },
      });
      await pause(20);
      const responses =
        (await call(`${kind}.read`, { session: session.session })).messages;
      ok(
        responses.some((m: any) =>
          kind === "debug"
            ? m.message.event === "reverseResponded" &&
              m.message.body.command === "runInTerminal"
            : m.message.method === "reverseResponded"
        ),
      );
      const abort = new AbortController();
      const pending = call(`${kind}.request`, {
        session: session.session,
        method: "hang",
        parameters: {},
      }, { ...caller, signal: abort.signal });
      setTimeout(() => abort.abort(), 30);
      await rejects(() => pending, /cancel/);
      await call(`${kind}.stop`, { session: session.session });
    }
    await call("index.refresh");
    for (let i = 0; i < 200; i++) {
      if ((await call("index.status")).phase === "completed") break;
      await pause(20);
    }
    const symbols = await call("index.query", {
      kind: "symbols",
      query: "answer",
    });
    ok(symbols.items.some((s: any) => s.name === "answer"));
    await call("files.beginWrite", { path: "abandoned.txt", version: null });
    await service.release(caller.owner!);
    ok(
      ![...Deno.readDirSync(root)].some((e) =>
        e.name.startsWith(".maghemite-write-")
      ),
    );
    eq(service.sessions.size, 0);
    // Stored values survive a fresh store instance, while ephemeral handles do not.
    const { SettingsStore } = await import("./settings.ts");
    eq(
      (await new SettingsStore(join(data, "modules")).request(
        "settings",
        "get",
        caller.moduleId,
        { key: "font" },
      ) as any).version,
      setting.version,
    );
  } finally {
    await service.close();
    await Deno.remove(temp, { recursive: true });
  }
});
Deno.test("new API authorization and strict schemas reject forgery before dispatch", async () => {
  let calls = 0;
  const services = {
    methods: () => Object.keys(SERVICE_METHODS) as AppMethod[],
    request: async () => {
      calls++;
      return null;
    },
  };
  const signal = new AbortController().signal;
  await rejects(
    () =>
      applicationRequest(services, "test.app", new Set(["terminal.use"]), {
        method: "terminal.create",
        parameters: { profile: "shell" },
      }, signal),
    /process.execute/,
  );
  eq(calls, 0);
  const available = await applicationRequest(
    services,
    "test.app",
    new Set(["terminal.use"]),
    { method: "app.describe", parameters: {} },
    signal,
  ) as any;
  ok(!available.methods.includes("terminal.create"));
  for (const method of Object.keys(SERVICE_METHODS)) {
    throws(
      () => validateAppRequest(method, { owner: "forged" }),
      /Invalid parameters/,
    );
  }
});
Deno.test("workbench services: atomic edits, selections, diagnostics, views and transfer snapshots", () => {
  const documents = [
    documentFromText("a.md", "alpha"),
    documentFromText("b.ts", "beta"),
  ];
  let selected: any;
  const views: any[] = [];
  const app = createWorkbenchApplication({
    documents: () => documents,
    active: () => ({ type: "document", documentId: "a.md" }),
    mode: () => "develop",
    edit: (id, text) => {
      documents.find((d) => d.id === id)!.content = text;
      app.changed(id);
    },
    open: () => {},
    layout: () => {},
    notify: () => {},
    output: () => {},
    create: (d) => documents.push(d),
    saved: (id, text) => {
      documents.find((d) => d.id === id)!.savedContent = text;
    },
    select: (...args) => selected = args,
    view: (v, remove) => views.push({ v, remove }),
  });
  const call = (m: AppMethod, p: Json = {}) =>
    app.invoke(m, p, "test.app", "owner") as any;
  const a = call("documents.read", { id: "a.md" }).document,
    b = call("documents.read", { id: "b.ts" }).document;
  throws(
    () =>
      call("documents.applyEdits", {
        edits: [{ id: a.id, version: a.version, from: 0, to: 1, text: "A" }, {
          id: b.id,
          version: "stale",
          from: 0,
          to: 1,
          text: "B",
        }],
      }),
    /conflict/,
  );
  eq(documents[0].content, "alpha");
  call("documents.applyEdits", {
    edits: [{ id: a.id, version: a.version, from: 0, to: 1, text: "A" }, {
      id: b.id,
      version: b.version,
      from: 0,
      to: 1,
      text: "B",
    }],
  });
  eq(documents.map((d) => d.content), ["Alpha", "Beta"]);
  app.undo();
  eq(documents.map((d) => d.content), ["alpha", "beta"]);
  const version = call("documents.read", { id: "a.md" }).document.version;
  call("editor.setSelection", { id: "a.md", version, anchor: 1, head: 3 });
  eq(selected, ["a.md", 1, 3]);
  eq(call("editor.getSelection", { id: "a.md" }).head, 3);
  call("diagnostics.publish", {
    id: "lint",
    documentId: "a.md",
    version,
    items: [{ message: "Example", severity: "warning", line: 1, column: 0 }],
  });
  eq(app.diagnostics().length, 1);
  call("views.publish", {
    id: "view",
    title: "Example",
    location: "secondary",
    blocks: [{ kind: "text", text: "<script>literal</script>" }],
  });
  eq(app.views().length, 1);
  throws(
    () =>
      call("views.publish", {
        id: "bad",
        title: "Bad",
        location: "editor",
        blocks: [{ kind: "button", text: "Run", command: "other.module.run" }],
      }),
    /this module/,
  );
  const snapshot = app.internal(
    "snapshot.begin",
    { id: "a.md", version },
    "owner",
  ) as any;
  call("documents.applyEdit", {
    id: "a.md",
    version,
    from: 0,
    to: 0,
    text: "new ",
  });
  eq(app.diagnostics().length, 0);
  app.internal("snapshot.commit", snapshot, "owner");
  eq(documents[0].savedContent, "alpha");
  eq(documents[0].content, "new alpha");
  app.release("owner");
  eq(app.views().length, 0);
});
