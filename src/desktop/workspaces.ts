import { isAbsolute, join } from "node:path";

export type FolderPicker = (
  initial: string,
  signal: AbortSignal,
) => Promise<string | null>;

/** Paths are private host preferences, never module-provided filesystem authority. */
export class WorkspaceHistory {
  constructor(private readonly directory: string) {}
  async list(): Promise<string[]> {
    try {
      const text = await Deno.readTextFile(
        join(this.directory, "workspaces.json"),
      );
      if (text.length > 64_000) return [];
      const value = JSON.parse(text);
      if (!Array.isArray(value)) return [];
      return [
        ...new Set(
          value.filter((p): p is string =>
            typeof p === "string" && p.length <= 4096 && isAbsolute(p) &&
            !p.includes("\0")
          ),
        ),
      ].slice(0, 10);
    } catch (error) {
      if (
        error instanceof Deno.errors.NotFound || error instanceof SyntaxError
      ) return [];
      throw error;
    }
  }
  async remember(root: string) {
    const paths = [root, ...(await this.list()).filter((p) => p !== root)]
      .slice(0, 10);
    const target = join(this.directory, "workspaces.json");
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      await Deno.writeTextFile(temporary, JSON.stringify(paths), {
        mode: 0o600,
      });
      await Deno.rename(temporary, target);
    } finally {
      await Deno.remove(temporary).catch(() => {});
    }
  }
}

/** Deno Desktop has no folder-dialog API yet. Use OS dialogs without a shell. */
export const pickFolder: FolderPicker = async (initial, signal) => {
  const linux = [
    {
      command: "zenity",
      args: [
        "--file-selection",
        "--directory",
        "--title=Open folder - Maghemite",
        ...(initial ? [`--filename=${initial}/`] : []),
      ],
    },
    {
      command: "kdialog",
      args: [
        "--getexistingdirectory",
        initial || ".",
        "--title",
        "Open folder - Maghemite",
      ],
    },
  ];
  if (Deno.env.get("XDG_CURRENT_DESKTOP")?.toLowerCase().includes("kde")) {
    linux.reverse();
  }
  const choices = Deno.build.os === "linux"
    ? linux
    : Deno.build.os === "darwin"
    ? [{
      command: "osascript",
      args: [
        "-e",
        'POSIX path of (choose folder with prompt "Open folder - Maghemite")',
      ],
    }]
    : [{
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-STA",
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; $picker = New-Object System.Windows.Forms.FolderBrowserDialog; $picker.Description = 'Open folder - Maghemite'; if ($picker.ShowDialog() -eq 'OK') { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output $picker.SelectedPath }",
      ],
    }];
  for (const choice of choices) {
    signal.throwIfAborted();
    try {
      const result = await new Deno.Command(choice.command, {
        args: choice.args,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
        signal,
      }).output();
      signal.throwIfAborted();
      if (result.code === 1 && Deno.build.os === "linux") return null;
      const error = new TextDecoder().decode(result.stderr);
      if (Deno.build.os === "darwin" && error.includes("(-128)")) return null;
      if (!result.success) {
        throw new Error(
          "The system folder dialog could not open. Enter a folder path below.",
        );
      }
      return new TextDecoder().decode(result.stdout).replace(/[\r\n]+$/, "") ||
        null;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
  }
  throw new Error(
    "No system folder picker found. Install zenity or kdialog, or enter a folder path below.",
  );
};
