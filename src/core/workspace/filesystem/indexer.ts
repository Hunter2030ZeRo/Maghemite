import { isAbsolute, join, relative, resolve } from "node:path";
import { CoreBridge, type IndexStatus } from "../../../native/core.ts";

export interface WorkspaceIndexOptions {
  /** Defaults to the platform's per-user application data directory. */
  dataDirectory?: string;
  onStatus?: (status: IndexStatus) => void;
  onError?: (error: Error) => void;
  onChange?: (paths: string[]) => void;
}

function applicationDataDirectory(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  switch (Deno.build.os) {
    case "windows": {
      const local = Deno.env.get("LOCALAPPDATA") ?? Deno.env.get("APPDATA");
      if (local) return join(local, "Maghemite");
      if (home) return join(home, "AppData", "Local", "Maghemite");
      break;
    }
    case "darwin":
      if (home) {
        return join(home, "Library", "Application Support", "Maghemite");
      }
      break;
    default: {
      const xdg = Deno.env.get("XDG_DATA_HOME");
      if (xdg && isAbsolute(xdg)) return join(xdg, "maghemite");
      if (home) return join(home, ".local", "share", "maghemite");
    }
  }
  throw new Error("Cannot determine Maghemite application data directory");
}

async function databasePath(root: string, directory: string): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(root)),
  );
  const name = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const indexDirectory = join(directory, "index");
  await Deno.mkdir(indexDirectory, { recursive: true });
  return join(indexDirectory, `${name}.sqlite`);
}

/** Owns OS file watching and a single index job at a time for one workspace. */
export class WorkspaceIndexService {
  private readonly pending = new Set<string>();
  private readonly watcher: Deno.FsWatcher;
  private watchTask: Promise<void> = Promise.resolve();
  private activeRun: Promise<void> | undefined;
  private activeJob: bigint | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private fullScanPending = true;
  private closed = false;
  lastError: Error | undefined;

  private constructor(
    private readonly core: CoreBridge,
    readonly workspaceId: bigint,
    readonly root: string,
    private readonly options: WorkspaceIndexOptions,
    watcher: Deno.FsWatcher,
  ) {
    this.watcher = watcher;
  }

  static async open(
    core: CoreBridge,
    root: string,
    options: WorkspaceIndexOptions = {},
  ): Promise<WorkspaceIndexService> {
    const canonicalRoot = await Deno.realPath(root);
    const directory = options.dataDirectory ?? applicationDataDirectory();
    const database = await databasePath(canonicalRoot, resolve(directory));
    const workspaceId = core.openWorkspace(canonicalRoot, database);
    try {
      // Start watching before the initial scan so changes during it are retained.
      const watcher = Deno.watchFs(canonicalRoot, { recursive: true });
      const service = new WorkspaceIndexService(
        core,
        workspaceId,
        canonicalRoot,
        options,
        watcher,
      );
      service.watchTask = service.consumeEvents();
      service.schedule(0);
      return service;
    } catch (error) {
      core.closeWorkspace(workspaceId);
      throw error;
    }
  }

  requestFullScan(): void {
    if (this.closed) throw new Error("Workspace index service is closed");
    this.fullScanPending = true;
    this.pending.clear();
    this.schedule(0);
  }

  private async consumeEvents(): Promise<void> {
    try {
      for await (const event of this.watcher) {
        if (this.closed) break;
        if (event.kind === "access") continue;
        this.options.onChange?.(
          event.paths.slice(0, 8).map((p) =>
            relative(this.root, p).slice(0, 128)
          ),
        );
        if (
          event.kind === "any" || event.kind === "other" ||
          event.paths.length === 0
        ) {
          this.fullScanPending = true;
          this.pending.clear();
        } else if (!this.fullScanPending) {
          for (const eventPath of event.paths) {
            const path = resolve(eventPath);
            const suffix = relative(this.root, path);
            if (
              suffix === "" || suffix === ".." || isAbsolute(suffix) ||
              suffix.startsWith(`..${Deno.build.os === "windows" ? "\\" : "/"}`)
            ) {
              this.fullScanPending = true;
              this.pending.clear();
              break;
            }
            this.pending.add(path);
          }
          if (this.pending.size > 128) {
            this.fullScanPending = true;
            this.pending.clear();
          }
        }
        this.schedule(150);
      }
    } catch (error) {
      if (!this.closed) this.reportError(error);
    }
  }

  private schedule(delayMs: number): void {
    if (this.closed) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.activeRun) return;
      const run = this.pump();
      this.activeRun = run;
      void run.finally(() => {
        this.activeRun = undefined;
        if (!this.closed && (this.fullScanPending || this.pending.size > 0)) {
          this.schedule(0);
        }
      });
    }, delayMs);
  }

  private async pump(): Promise<void> {
    while (!this.closed && (this.fullScanPending || this.pending.size > 0)) {
      const full = this.fullScanPending;
      const paths = [...this.pending];
      this.fullScanPending = false;
      this.pending.clear();
      let jobId: bigint | undefined;
      try {
        jobId = full
          ? this.core.startIndex(this.workspaceId)
          : this.core.refreshPaths(this.workspaceId, paths);
        this.activeJob = jobId;
        for (;;) {
          const status = this.core.indexStatus(jobId);
          try {
            this.options.onStatus?.(status);
          } catch (error) {
            this.reportError(error);
          }
          if (status.phase === "completed") break;
          if (status.phase === "failed") {
            throw new Error(this.core.indexError(jobId) || "Index job failed");
          }
          if (status.phase === "cancelled") {
            if (!this.closed) throw new Error("Index job was cancelled");
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      } catch (error) {
        if (!this.closed) this.reportError(error);
      } finally {
        if (jobId !== undefined) {
          this.activeJob = undefined;
          this.core.releaseIndex(jobId);
        }
      }
    }
  }

  private reportError(error: unknown): void {
    this.lastError = error instanceof Error ? error : new Error(String(error));
    try {
      this.options.onError?.(this.lastError);
    } catch {
      // Application callbacks must not interrupt native job cleanup.
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.watcher.close();
    if (this.activeJob !== undefined) this.core.cancelIndex(this.activeJob);
    await this.activeRun;
    await this.watchTask;
    this.core.closeWorkspace(this.workspaceId);
  }
}
