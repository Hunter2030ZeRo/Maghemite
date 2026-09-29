import type { OwnedProcessUsage } from "../modules/host/process_usage.ts";

export const ownedProcessUsageSymbols = {
  mg_owned_process_usage: {
    parameters: ["buffer", "usize", "buffer"],
    result: "i32",
    nonblocking: true,
  },
} as const;

const MAX_OWNED_PROCESSES = 4095;
const PROCESS_WORDS = 3;
const RSS_UNKNOWN = 0xffff_ffff_ffff_ffffn;
const FLAG_SUPPORTED = 1n;
const FLAG_COMPLETE = 2n;

type NativeOwnedProcessUsage = (
  output: BigUint64Array,
  capacity: bigint,
  meta: BigUint64Array,
) => Promise<number>;

export async function sampleNativeOwnedProcesses(
  read: NativeOwnedProcessUsage,
): Promise<OwnedProcessUsage> {
  const output = new BigUint64Array(
    MAX_OWNED_PROCESSES * PROCESS_WORDS,
  );
  const meta = new BigUint64Array(2);
  const code = await read(output, BigInt(MAX_OWNED_PROCESSES), meta);
  if (code !== 0) throw new Error(`Native process telemetry failed: ${code}`);

  const count = Number(meta[0]);
  if (!Number.isSafeInteger(count) || count > MAX_OWNED_PROCESSES) {
    throw new Error("Native process count is invalid");
  }
  const supported = (meta[1] & FLAG_SUPPORTED) !== 0n;
  const complete = (meta[1] & FLAG_COMPLETE) !== 0n;
  const processes: OwnedProcessUsage["processes"] = [];
  for (let index = 0; index < count; index++) {
    const offset = index * PROCESS_WORDS;
    const pid = Number(output[offset]);
    const rss = output[offset + 1];
    const rssBytes = rss === RSS_UNKNOWN ? null : Number(rss);
    const role = output[offset + 2];
    if (!Number.isSafeInteger(pid) || pid < 1) {
      throw new Error("Native process PID is invalid");
    }
    if (
      rssBytes !== null &&
      (!Number.isSafeInteger(rssBytes) || rssBytes < 0)
    ) {
      throw new Error("Native process RSS is invalid");
    }
    if (role !== 0n && role !== 1n) {
      throw new Error("Native process role is invalid");
    }
    processes.push({
      pid,
      rssBytes,
      ...(role === 1n ? { role: "cef-renderer" as const } : {}),
    });
  }
  return {
    source: supported ? "linux-proc" : "unavailable",
    complete: supported && complete,
    processes,
  };
}
