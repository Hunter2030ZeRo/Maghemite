export const MAX_FRAME = 64 * 1024;
export const encoder = new TextEncoder();

export function jsonCopy(
  value: unknown,
): import("../../../modules-sdk/js/mod.ts").Json {
  const text = JSON.stringify(value, (_key, item) => {
    if (
      item === undefined || typeof item === "function" ||
      typeof item === "symbol" ||
      (typeof item === "number" && !Number.isFinite(item))
    ) throw new Error("Expected a JSON value");
    return item;
  });
  if (text === undefined || encoder.encode(text).length >= MAX_FRAME - 1024) {
    throw new Error("JSON value exceeds module message limit");
  }
  return JSON.parse(text);
}

/** Validate a value already decoded by our bounded JSON frame reader.
 * The parsed tree is owned by the receiver; no stringify/parse copy is needed.
 * JSON.parse accepts huge exponents as Infinity, so still check numeric values.
 */
export function receivedJson(
  value: unknown,
): import("../../../modules-sdk/js/mod.ts").Json {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (
      item === null || typeof item === "string" || typeof item === "boolean"
    ) continue;
    if (typeof item === "number" && Number.isFinite(item)) continue;
    if (Array.isArray(item)) {
      pending.push(...item);
      continue;
    }
    if (typeof item === "object" && item !== null) {
      pending.push(...Object.values(item));
      continue;
    }
    throw new Error("Expected a JSON value");
  }
  return value as import("../../../modules-sdk/js/mod.ts").Json;
}

/** Whole frames decode directly from the input chunk. Fragmented frames use a
 * reusable, geometrically growing buffer (bounded by MAX_FRAME).
 */
export async function* frames(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = new Uint8Array(0);
  let used = 0;
  const append = (bytes: Uint8Array) => {
    const size = used + bytes.length;
    if (size >= MAX_FRAME) throw new Error("Module frame exceeds limit");
    if (size > buffer.length) {
      const next = new Uint8Array(
        Math.min(MAX_FRAME, Math.max(256, size, buffer.length * 2)),
      );
      next.set(buffer.subarray(0, used));
      buffer = next;
    }
    buffer.set(bytes, used);
    used = size;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        if (used) throw new Error("Truncated module frame");
        return;
      }
      let start = 0;
      for (let i = 0; i < value.length; i++) {
        if (value[i] !== 10) continue;
        const part = value.subarray(start, i);
        if (used + part.length >= MAX_FRAME) {
          throw new Error("Module frame exceeds limit");
        }
        let line = part;
        if (used) {
          append(part);
          line = buffer.subarray(0, used);
        }
        const parsed = JSON.parse(decoder.decode(line));
        if (
          parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
        ) throw new Error("Invalid module frame");
        used = 0;
        yield parsed;
        start = i + 1;
      }
      if (start < value.length) append(value.subarray(start));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function frame(value: unknown): Uint8Array {
  const bytes = encoder.encode(JSON.stringify(value) + "\n");
  if (bytes.length > MAX_FRAME) throw new Error("Module frame exceeds limit");
  return bytes;
}
