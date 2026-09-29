import { join } from "node:path";
import type { Json } from "../../../modules-sdk/js/mod.ts";
import { jsonCopy } from "../../modules/runtimes/protocol.ts";

/** Durable module namespaces. Guests never choose a storage path or another owner. */
export class SettingsStore {
  #queue: Promise<unknown> = Promise.resolve();
  constructor(private directory: string) {}
  request(
    namespace: "settings" | "storage",
    action: string,
    moduleId: string,
    parameters: Record<string, Json>,
    signal?: AbortSignal,
  ): Promise<Json> {
    const work = this.#queue.then(async () => {
      signal?.throwIfAborted();
      if (!/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(moduleId)) {
        throw new Error("Invalid storage owner");
      }
      await Deno.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = join(this.directory, `${moduleId}.${namespace}.json`);
      let records: Record<string, { value: Json; version: string }> = Object
        .create(null);
      try {
        const handle = await Deno.open(file, { read: true });
        try {
          if ((await handle.stat()).size > 512 * 1024) {
            throw new Error("Settings storage exceeds limit");
          }
          const bytes = new Uint8Array(512 * 1024 + 1);
          let used = 0;
          while (used < bytes.length) {
            const n = await handle.read(bytes.subarray(used));
            if (n === null) break;
            used += n;
          }
          if (used > 512 * 1024) {
            throw new Error("Settings storage exceeds limit");
          }
          const parsed = JSON.parse(
            new TextDecoder().decode(bytes.subarray(0, used)),
          );
          if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
            throw new Error("Corrupt settings store");
          }
          if (
            Object.keys(parsed).length > 128 ||
            Object.values(parsed).some((r: any) =>
              !r || typeof r !== "object" || typeof r.version !== "string" ||
              !("value" in r)
            )
          ) throw new Error("Corrupt settings records");
          records = Object.assign(Object.create(null), parsed);
        } finally {
          handle.close();
        }
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
      const key = parameters.key as string;
      if (action === "keys") return { keys: Object.keys(records).sort() };
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)) {
        throw new Error("Invalid storage key");
      }
      const previous = records[key];
      if (action === "get") {
        return previous ? jsonCopy(previous) : { value: null, version: null };
      }
      if ((previous?.version ?? null) !== parameters.version) {
        throw new Error("Settings version conflict");
      }
      const version = crypto.randomUUID();
      if (action === "delete") delete records[key];
      else records[key] = { value: jsonCopy(parameters.value), version };
      const encoded = new TextEncoder().encode(JSON.stringify(records));
      if (Object.keys(records).length > 128 || encoded.length > 512 * 1024) {
        throw new Error("Module storage quota exceeded");
      }
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        await Deno.writeFile(temporary, encoded, {
          createNew: true,
          mode: 0o600,
        });
        signal?.throwIfAborted();
        await Deno.rename(temporary, file);
      } finally {
        await Deno.remove(temporary).catch((e) => {
          if (!(e instanceof Deno.errors.NotFound)) throw e;
        });
      }
      return action === "delete" ? null : { version };
    });
    this.#queue = work.catch(() => {});
    return work;
  }
  async close() {
    await this.#queue;
  }
}
