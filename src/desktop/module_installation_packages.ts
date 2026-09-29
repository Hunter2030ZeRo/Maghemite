import { join } from "node:path";
import type {
  AotStore,
  PreparedPackage,
  ReviewedPackage,
} from "../modules/host/aot.ts";
import {
  privateDirectory,
  regularPath,
  removeOwned,
  syncDirectory,
} from "../modules/host/aot-files.ts";
import { copyReviewedPackage } from "../modules/host/aot-snapshot.ts";
import { slotId } from "../modules/host/aot-schema.ts";
import { InstallationError } from "../shared/module_installations.ts";
import { check, type InstalledRecord } from "./module_installation_registry.ts";

type HeldPackage = {
  reviewed: ReviewedPackage;
  prepared: PreparedPackage;
  reference: { release(): void };
};

/** Committed references and private snapshots, separate from host runtime pins. */
export class InstallationPackages {
  readonly held = new Map<string, HeldPackage>();
  readonly #reviewed = new Map<string, ReviewedPackage>();
  constructor(readonly store: AotStore) {}
  path(slot: string): string {
    return join(this.store.directory, "packages", slotId(slot));
  }
  hold(reviewed: ReviewedPackage, prepared: PreparedPackage): void {
    this.#reviewed.set(reviewed.slot, reviewed);
    if (!this.held.has(prepared.slot)) {
      this.held.set(prepared.slot, {
        reviewed,
        prepared,
        reference: this.store.retain(prepared),
      });
    }
  }
  async ready(record: InstalledRecord): Promise<PreparedPackage> {
    const existing = this.held.get(record.slot);
    if (existing) return existing.prepared;
    const reviewed = await this.store.restore(record.slot);
    this.#reviewed.set(record.slot, reviewed);
    const snapshot = this.store.snapshot(reviewed);
    check(
      snapshot.package.manifest.id === record.id,
      "Installed module identity changed",
    );
    if (record.artifactSetId === undefined && snapshot.targets.length) {
      throw new InstallationError(
        "maintenance",
        "Legacy native installation needs maintenance",
      );
    }
    const prepared = await this.store.restorePrepared(
      record.slot,
      record.artifactSetId ?? null,
    );
    this.hold(reviewed, prepared);
    return prepared;
  }
  async artifactBytes(record: InstalledRecord): Promise<number | null> {
    if (record.artifactSetId === undefined) return null;
    if (record.artifactSetId === null) return 0;
    const held = this.held.get(record.slot);
    if (
      !held || held.prepared.artifactSetId !== record.artifactSetId
    ) return null;
    const { directory, descriptor } = this.store.details(held.prepared);
    if (!directory || !descriptor) return null;
    try {
      await privateDirectory(this.store.directory, directory);
      await regularPath(directory, join(directory, "descriptor.json"));
      for (const target of descriptor.targets) {
        const path = join(directory, target.artifact.file);
        await regularPath(directory, path);
        if ((await Deno.lstat(path)).size !== target.artifact.size) return null;
      }
    } catch (error) {
      if (error instanceof Error) return null;
      throw error;
    }
    return this.store.artifactBytes(held.prepared);
  }
  async maintenanceCopy(
    record: InstalledRecord,
    signal: AbortSignal,
  ): Promise<ReviewedPackage> {
    // This is a trusted private-to-private copy, not an import of native receipts.
    const slot = crypto.randomUUID();
    await privateDirectory(this.store.directory, this.path(record.slot));
    await copyReviewedPackage(this.path(record.slot), this.path(slot), signal);
    try {
      const reviewed = await this.store.restore(slot);
      await syncDirectory(join(this.store.directory, "packages"));
      return reviewed;
    } catch (error) {
      await removeOwned(this.path(slot));
      throw error;
    }
  }
  async discard(
    reviewed: ReviewedPackage,
    prepared?: PreparedPackage,
  ): Promise<void> {
    if (prepared) await this.store.reclaim(prepared);
    await this.store.discardReviewed(reviewed);
  }
  async reclaim(record: InstalledRecord): Promise<void> {
    const held = this.held.get(record.slot);
    if (held) {
      held.reference.release();
      await this.discard(held.reviewed, held.prepared);
      this.held.delete(record.slot);
    } else {
      // Legacy/native-unready records can still have a reviewed capability.
      // Fence that identity through the store before removing orphan objects.
      const reviewed = this.#reviewed.get(record.slot);
      if (reviewed) await this.store.discardReviewed(reviewed);
      await this.removeOrphan(record.slot);
    }
    this.#reviewed.delete(record.slot);
  }
  async removeOrphan(slot: string): Promise<void> {
    slotId(slot);
    for (
      const path of [
        join(this.store.directory, "aot", "generations", slot),
        this.path(slot),
      ]
    ) {
      try {
        await privateDirectory(this.store.directory, path);
        await removeOwned(path);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    await syncDirectory(join(this.store.directory, "packages"));
    await syncDirectory(join(this.store.directory, "aot", "generations"));
  }
  async prune(records: readonly InstalledRecord[]): Promise<void> {
    const referenced = new Set(records.map((record) => record.slot));
    const slots = new Set<string>();
    for (const directory of ["packages", "aot/generations"]) {
      for await (
        const entry of Deno.readDir(join(this.store.directory, directory))
      ) {
        if (/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(entry.name)) {
          slots.add(entry.name);
        }
      }
    }
    for (const slot of slots) {
      if (!referenced.has(slot)) await this.removeOrphan(slot);
    }
  }
  close(): void {
    for (const item of this.held.values()) item.reference.release();
    this.held.clear();
    this.#reviewed.clear();
  }
}
