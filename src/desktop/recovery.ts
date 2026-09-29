import { join } from "node:path";
import { decodeSession } from "../shared/workspace.ts";
import type { Json } from "../../modules-sdk/js/mod.ts";

const LIMIT = 3_000_000, CHUNK = 4096;
type Record = { revision: string; text: string };
/** Atomic host snapshots, scoped by canonical workspace identity. No workspace file is modified. */
export class RecoveryStore {
  #uploads = new Map<
    string,
    { workspace: string; revision: Json; text: string; expires: number }
  >();
  #reads = new Map<string, { record: Record; expires: number }>();
  #busy = false;
  constructor(readonly directory: string) {}
  #path(workspace: string) {
    if (!/^[a-f0-9]{64}$/.test(workspace)) {
      throw new Error("Invalid recovery workspace");
    }
    return join(this.directory, "recovery", `${workspace}.json`);
  }
  async #load(workspace: string): Promise<Record | null> {
    try {
      const file = await Deno.open(this.#path(workspace));
      let value: Record;
      try {
        if ((await file.stat()).size > 18_100_000) {
          throw new Error("Recovery file too large");
        }
        value = JSON.parse(await new Response(file.readable).text());
      } finally {
        try {
          file.close();
        } catch { /* stream closed it */ }
      }
      if (
        !value || typeof value.revision !== "string" ||
        !decodeSession(value.text)
      ) throw new Error("Invalid recovery snapshot; original retained");
      return value;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
  }
  resetTransfers() {
    this.#uploads.clear();
    this.#reads.clear();
  }
  async request(
    workspace: string,
    method: string,
    p: { [key: string]: Json },
    signal: AbortSignal,
  ): Promise<Json> {
    signal.throwIfAborted();
    for (const [id, value] of this.#uploads) {
      if (value.expires < Date.now()) this.#uploads.delete(id);
    }
    for (const [id, value] of this.#reads) {
      if (value.expires < Date.now()) this.#reads.delete(id);
    }
    if (method === "recovery.open") {
      const record = await this.#load(workspace);
      if (!record) return { revision: null, transfer: null };
      if (this.#reads.size >= 2) throw new Error("Too many recovery downloads");
      const transfer = crypto.randomUUID();
      this.#reads.set(transfer, { record, expires: Date.now() + 60_000 });
      return { revision: record.revision, transfer };
    }
    if (method === "recovery.read") {
      const read = this.#reads.get(String(p.transfer));
      if (
        !read || !Number.isSafeInteger(p.offset) || Number(p.offset) < 0 ||
        Number(p.offset) > read.record.text.length
      ) throw new Error("Invalid recovery read");
      const offset = Number(p.offset),
        text = read.record.text.slice(offset, offset + CHUNK);
      const nextOffset = offset + text.length < read.record.text.length
        ? offset + text.length
        : null;
      if (nextOffset === null) this.#reads.delete(String(p.transfer));
      return { text, nextOffset };
    }
    if (method === "recovery.begin") {
      if (
        this.#uploads.size >= 2 ||
        !(p.revision === null || typeof p.revision === "string")
      ) throw new Error("Invalid recovery upload");
      const transfer = crypto.randomUUID();
      this.#uploads.set(transfer, {
        workspace,
        revision: p.revision,
        text: "",
        expires: Date.now() + 60_000,
      });
      return { transfer };
    }
    const upload = this.#uploads.get(String(p.transfer));
    if (!upload || upload.workspace !== workspace) {
      throw new Error("Recovery upload expired");
    }
    if (method === "recovery.chunk") {
      if (
        typeof p.text !== "string" || p.text.length > CHUNK ||
        p.offset !== upload.text.length ||
        upload.text.length + p.text.length > LIMIT
      ) throw new Error("Invalid recovery chunk");
      upload.text += p.text;
      upload.expires = Date.now() + 60_000;
      return null;
    }
    this.#uploads.delete(String(p.transfer));
    if (method !== "recovery.commit") {
      throw new Error("Unknown recovery operation");
    }
    if (!decodeSession(upload.text)) {
      throw new Error("Invalid workspace snapshot");
    }
    if (this.#busy) throw new Error("Recovery write in progress");
    this.#busy = true;
    const path = this.#path(workspace),
      temp = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      const previous = await this.#load(workspace);
      if ((previous?.revision ?? null) !== upload.revision) {
        throw new Error(
          "Recovery changed elsewhere; reconnect before saving another snapshot",
        );
      }
      const revision = crypto.randomUUID();
      await Deno.mkdir(join(this.directory, "recovery"), {
        recursive: true,
        mode: 0o700,
      });
      const file = await Deno.open(temp, {
        createNew: true,
        write: true,
        mode: 0o600,
      });
      try {
        const bytes = new TextEncoder().encode(
          JSON.stringify({ revision, text: upload.text }),
        );
        let offset = 0;
        while (offset < bytes.length) {
          offset += await file.write(bytes.subarray(offset));
        }
        await file.sync();
      } finally {
        file.close();
      }
      signal.throwIfAborted();
      await Deno.rename(temp, path);
      return { revision };
    } finally {
      this.#busy = false;
      await Deno.remove(temp).catch(() => {});
    }
  }
}
