import { basename, isAbsolute } from "node:path";
import type { ToolProfile } from "./processes.ts";

/** Host-selected user shell. Never resolved from a guest or renderer command string. */
export async function defaultShell(): Promise<ToolProfile> {
  const windows = Deno.build.os === "windows";
  const configured = Deno.env.get(windows ? "COMSPEC" : "SHELL");
  const candidates = [
    configured,
    windows ? "C:\\Windows\\System32\\cmd.exe" : "/bin/sh",
  ];
  for (const command of candidates) {
    if (!command || !isAbsolute(command) || command.includes("\0")) continue;
    try {
      const stat = await Deno.stat(command);
      if (
        !stat.isFile || (!windows && stat.mode !== null && !(stat.mode & 0o111))
      ) continue;
    } catch {
      continue;
    }
    return {
      id: basename(command),
      kind: "terminal",
      command,
      args: windows ? [] : ["-i"],
      env: {
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        TERM_PROGRAM: "Maghemite",
      },
    };
  }
  throw new Error("No usable system shell was found");
}
