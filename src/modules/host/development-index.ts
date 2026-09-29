import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { AotError } from "../../shared/module_aot.ts";
import {
  inspectFile,
  readBounded,
  regularPath,
  removeOwned,
  syncDirectory,
  writeSynced,
} from "./aot-files.ts";
import { digest, invariant, slotId } from "./aot-schema.ts";

const INDEX_LIMIT = 256 * 1024;
const PACKAGE_LIMIT = 192 * 1024 * 1024;
const RECORD_LIMIT = 100;

export interface DevelopmentReference {
  readonly packageSha256: string;
  readonly slot: string;
  readonly artifactSetId: string | null;
}

type PackageEntry =
  | { readonly kind: "directory"; readonly path: string }
  | {
    readonly kind: "file";
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
  };

function record(value: unknown): Record<string, unknown> {
  invariant(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "Expected object",
  );
  return Object.fromEntries(Object.entries(value));
}

function parseReference(value: unknown): DevelopmentReference {
  const item = record(value);
  invariant(
    Object.keys(item).toSorted().join(",") ===
      "artifactSetId,packageSha256,slot",
    "Invalid development index fields",
  );
  return Object.freeze({
    packageSha256: digest(item.packageSha256),
    slot: slotId(item.slot),
    artifactSetId: item.artifactSetId === null
      ? null
      : digest(item.artifactSetId),
  });
}

export async function developmentPackageDigest(root: string): Promise<string> {
  const entries: PackageEntry[] = [];
  let total = 0;
  const visit = async (directory: string): Promise<void> => {
    const children = [];
    for await (const entry of Deno.readDir(directory)) children.push(entry);
    children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of children) {
      const path = join(directory, entry.name);
      const name = relative(root, path).replaceAll("\\", "/");
      invariant(
        name.length > 0 && name.length <= 4096,
        "Invalid reviewed package path",
      );
      const info = await Deno.lstat(path);
      invariant(
        !info.isSymlink && (info.isDirectory || info.isFile),
        "Invalid reviewed package entry",
      );
      if (info.isDirectory) {
        entries.push({ kind: "directory", path: name });
        await visit(path);
        continue;
      }
      const file = await inspectFile(path, PACKAGE_LIMIT - total);
      total += file.size;
      invariant(total <= PACKAGE_LIMIT, "Reviewed package exceeds size limit");
      entries.push({
        kind: "file",
        path: name,
        size: file.size,
        sha256: file.sha256,
      });
    }
  };
  await visit(root);
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export class DevelopmentIndex {
  readonly #path: string;
  private constructor(
    readonly root: string,
    readonly records: readonly DevelopmentReference[],
  ) {
    this.#path = join(root, "development-index.json");
  }

  static async open(root: string): Promise<DevelopmentIndex> {
    const path = join(root, "development-index.json");
    let bytes: Uint8Array;
    try {
      await regularPath(root, path);
      bytes = await readBounded(path, INDEX_LIMIT);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return new DevelopmentIndex(root, []);
      }
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError) {
        throw new AotError("invalid", "Malformed development index");
      }
      throw error;
    }
    const index = record(value);
    invariant(
      Object.keys(index).toSorted().join(",") === "records,schemaVersion" &&
        index.schemaVersion === 1 && Array.isArray(index.records) &&
        index.records.length <= RECORD_LIMIT,
      "Invalid development index",
    );
    const records = index.records.map(parseReference);
    invariant(
      new Set(records.map((record) => record.packageSha256)).size ===
        records.length,
      "Duplicate development index record",
    );
    return new DevelopmentIndex(root, Object.freeze(records));
  }

  find(packageSha256: string): DevelopmentReference | undefined {
    return this.records.find((record) =>
      record.packageSha256 === packageSha256
    );
  }

  async publish(reference: DevelopmentReference): Promise<DevelopmentIndex> {
    const next = Object.freeze([
      parseReference(reference),
      ...this.records.filter((record) =>
        record.packageSha256 !== reference.packageSha256
      ),
    ].slice(0, RECORD_LIMIT));
    const bytes = new TextEncoder().encode(JSON.stringify({
      schemaVersion: 1,
      records: next,
    }));
    invariant(bytes.length <= INDEX_LIMIT, "Development index exceeds limit");
    const temporary = join(
      this.root,
      `.development-index.${crypto.randomUUID()}.tmp`,
    );
    try {
      await writeSynced(temporary, bytes);
      await Deno.rename(temporary, this.#path);
      await syncDirectory(this.root);
    } finally {
      await removeOwned(temporary);
    }
    return new DevelopmentIndex(this.root, next);
  }
}
