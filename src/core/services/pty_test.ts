import { deepStrictEqual as eq, ok } from "node:assert/strict";
import { initializePty, TerminalSession } from "./pty.ts";
import { EventHub } from "./events.ts";
// PTY shared library has process lifetime; initialize before the test sanitizer baseline.
await initializePty();
Deno.test("deno-pty: real shell input, UTF-8 output, resize and close", async () => {
  let releases = 0;
  const terminal = new TerminalSession(
    "test",
    { id: "shell", kind: "terminal", command: "/bin/sh" },
    Deno.cwd(),
    80,
    24,
    new EventHub(),
    {
      started: () => {
        throw new Error("PTY does not expose a child PID");
      },
      release: () => releases++,
    },
  );
  try {
    terminal.resize(100, 30);
    terminal.write("printf 'PTY_UTF8_한글\\n'\nexit 7\n");
    await terminal.finished;
    ok(terminal.read().text.includes("PTY_UTF8_한글"));
    eq(terminal.exitCode, 7);
    eq(releases, 1);
  } finally {
    await terminal.close();
    eq(releases, 1);
  }
});
