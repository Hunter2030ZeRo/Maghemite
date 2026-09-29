import { deepStrictEqual as eq, ok, rejects, throws } from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { NativeApplicationServices } from "../core/services/application.ts";
import { initializePty, TerminalSession } from "../core/services/pty.ts";
import { defaultShell } from "../core/services/shell.ts";
import { Journal } from "../core/services/processes.ts";
import { DesktopApplication } from "./application.ts";
import type { Json } from "../../modules-sdk/js/mod.ts";
const library = Deno.env.get("MAGHEMITE_PTY_LIBRARY");
await initializePty(library);
const signal = new AbortController().signal;
async function until(test: () => boolean) {
  const end = Date.now() + 5000;
  while (!test() && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 20));
  }
  ok(test(), "PTY did not reach the expected state");
}
Deno.test("workbench terminal: real shell, Unicode, resize, interrupt, isolation, exit and workspace cleanup", async () => {
  const temp = await Deno.makeTempDir({ prefix: "maghemite-terminal-" });
  const root = `${temp}/workspace`, second = `${temp}/second`;
  await Deno.mkdir(root);
  await Deno.mkdir(second);
  const previous = Deno.env.get("SHELL");
  if (Deno.build.os !== "windows") Deno.env.set("SHELL", "/bin/sh");
  const native = await NativeApplicationServices.open({
    root,
    dataDirectory: `${temp}/data`,
    coreLibrary: fileURLToPath(
      new URL(
        "../../native/target/release/libmaghemite_core.so",
        import.meta.url,
      ),
    ),
    ptyLibrary: library,
  });
  const app = new DesktopApplication(native);
  const call = (action: string, p: Json = {}) =>
    app.terminal(action, p, signal);
  try {
    await rejects(() => call("create", { command: "/bin/sh" }), /parameters/);
    await rejects(() => call("create", { columns: 0 }), /Invalid/);
    const created = await call("create", { columns: 80, rows: 24 }) as {
      session: string;
    };
    const id = created.session;
    const terminal = native.sessions.get(id) as TerminalSession;
    await rejects(
      () =>
        native.request("terminal.read", { session: id }, {
          moduleId: "module",
          owner: "guest",
          signal,
        }),
      /owned/,
    );
    await rejects(
      () =>
        native.request("terminal.create", { profile: "workbench" }, {
          moduleId: "module",
          owner: "guest",
          signal,
        }),
      /No configured/,
    );
    await call("resize", { session: id, columns: 93, rows: 13 });
    eq(terminal.pty.getSize().cols, 93);
    eq(terminal.pty.getSize().rows, 13);
    await call("write", {
      session: id,
      text: "printf '\\n%s%s\\n' 'TTY_' '한글😀'; pwd; stty size\n",
    });
    await until(() =>
      terminal.output.text.includes("\r\nTTY_한글😀\r\n") &&
      terminal.output.text.includes("\r\n13 93\r\n")
    );
    ok(terminal.output.text.includes(root));
    await call("write", {
      session: id,
      text: "printf '\\n%s%s\\n' 'RUNNING_' 'job'; sleep 30\n",
    });
    await until(() => terminal.output.text.includes("\r\nRUNNING_job\r\n"));
    await call("write", { session: id, text: "\u0003" });
    await call("write", {
      session: id,
      text: "printf '\\n%s%s\\n' 'AFTER_' 'interrupt'\n",
    });
    await until(() => terminal.output.text.includes("\r\nAFTER_interrupt\r\n"));
    await call("write", { session: id, text: "exit 7\n" });
    await until(() => terminal.done);
    eq(terminal.exitCode, 7);
    throws(() => terminal.pty.getSize(), /closed/);
    await rejects(() => call("write", { session: id, text: "x" }), /closed/i);
    await call("close", { session: id });
    eq(native.sessions.size, 0);
    for (let i = 0; i < 2; i++) await call("create");
    const live = [...native.sessions.values()] as TerminalSession[];
    eq(live.length, 2);
    const prepared = await native.prepareWorkspace(second);
    await prepared!.commit();
    eq(native.sessions.size, 0);
    ok(live.every((s) => s.done));
  } finally {
    await native.close();
    if (previous === undefined) Deno.env.delete("SHELL");
    else Deno.env.set("SHELL", previous);
    await Deno.remove(temp, { recursive: true });
  }
});
Deno.test("terminal journals preserve Unicode across page and retention boundaries", () => {
  const journal = new Journal(16384);
  const source = "a".repeat(4095) + "😀" + "한글".repeat(3000);
  journal.append(source);
  let text = "", cursor = 0;
  for (;;) {
    const page = journal.read(cursor);
    ok(page.text.isWellFormed());
    text += page.text;
    if (page.cursor === cursor) break;
    cursor = page.cursor;
  }
  eq(text, source);
  const bounded = new Journal(4);
  bounded.append("😀abcd");
  ok(bounded.read(0).dropped);
  eq(bounded.read(0).text, "abcd");
  bounded.append("😀xyz");
  ok(bounded.read(0).text.isWellFormed());
  ok(bounded.text.length <= 4);
});

Deno.test("default shell falls back without exposing a renderer-controlled command", async () => {
  if (Deno.build.os === "windows") return;
  const previous = Deno.env.get("SHELL");
  try {
    Deno.env.set("SHELL", "/does-not-exist/maghemite-shell");
    const profile = await defaultShell();
    eq(profile.command, "/bin/sh");
    eq(profile.args, ["-i"]);
    eq(profile.env?.TERM, "xterm-256color");
  } finally {
    if (previous === undefined) Deno.env.delete("SHELL");
    else Deno.env.set("SHELL", previous);
  }
});
