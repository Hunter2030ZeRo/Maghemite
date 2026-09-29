export type OwnedProcessUsage = {
  source: "linux-proc" | "unavailable";
  complete: boolean;
  /** Descendants only: Deno.memoryUsage() supplies the root's RSS. */
  processes: {
    pid: number;
    rssBytes: number | null;
    role?: "cef-renderer";
  }[];
};
type OwnedProcessUsageReader = () =>
  | OwnedProcessUsage
  | Promise<OwnedProcessUsage>;
const nativeReaders: OwnedProcessUsageReader[] = [];

/** Private host seam installed only for the lifetime of an open native core. */
export function registerNativeOwnedProcessUsage(
  reader: OwnedProcessUsageReader,
): () => void {
  nativeReaders.push(reader);
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    const index = nativeReaders.lastIndexOf(reader);
    if (index >= 0) nativeReaders.splice(index, 1);
  };
}

function unavailable(error: unknown) {
  return error instanceof Deno.errors.NotFound ||
    error instanceof Deno.errors.PermissionDenied ||
    error instanceof Deno.errors.NotCapable;
}
export async function processRss(pid: number): Promise<number | null> {
  if (Deno.build.os !== "linux") return null;
  try {
    const status = await Deno.readTextFile(`/proc/${pid}/status`);
    const value = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    return value ? Number(value[1]) * 1024 : null;
  } catch (error) {
    if (unavailable(error)) return null;
    throw error;
  }
}

/** No PATH tools, process discovery outside our descendants, or guest permissions. */
export async function ownedProcessUsage(
  root = Deno.pid,
): Promise<OwnedProcessUsage> {
  const native = nativeReaders.at(-1);
  if (native && root === Deno.pid) return await native();
  if (Deno.build.os !== "linux") {
    return { source: "unavailable", complete: false, processes: [] };
  }
  const result: OwnedProcessUsage = {
    source: "linux-proc",
    complete: true,
    processes: [],
  };
  const seen = new Set([root]);
  const pending = [root];
  while (pending.length) {
    const pid = pending.pop();
    try {
      // Children can be created by any thread, not only the leader.
      for await (const thread of Deno.readDir(`/proc/${pid}/task`)) {
        if (!/^\d+$/.test(thread.name)) continue;
        const children = await Deno.readTextFile(
          `/proc/${pid}/task/${thread.name}/children`,
        );
        for (const value of children.trim().split(/\s+/).filter(Boolean)) {
          const child = Number(value);
          if (!Number.isSafeInteger(child) || child < 1 || seen.has(child)) {
            continue;
          }
          // Bound a diagnostic snapshot, not the allowed number of app processes.
          if (seen.size >= 4096) {
            result.complete = false;
            return result;
          }
          seen.add(child);
          const rssBytes = await processRss(child);
          result.processes.push({ pid: child, rssBytes });
          if (rssBytes === null) result.complete = false;
          pending.push(child);
        }
      }
    } catch (error) {
      if (!unavailable(error)) throw error;
      result.complete = false;
      if (pid === root) result.source = "unavailable";
    }
  }
  return result;
}
