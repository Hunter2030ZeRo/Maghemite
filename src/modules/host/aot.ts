import { join } from "node:path";
import {
  AotError, AOT_LIMITS, type ArtifactDescriptor, type ArtifactProducer,
} from "../../shared/module_aot.ts";
import { artifactSetId, digest, invariant, parseDescriptor, parseProducer, slotId } from "./aot-schema.ts";
import { contains, privateDirectory, readBounded, regularPath, removeOwned, syncDirectory } from "./aot-files.ts";
import { type GenerationExpectation, validateGeneration } from "./aot-generation.ts";
import { GenerationOwners } from "./aot-ownership.ts";
import { copyReviewedPackage, inspectSnapshot, type PackageSnapshot, validateSnapshot } from "./aot-snapshot.ts";
import { type AotStaging, StagingArea } from "./aot-staging.ts";
export type { AotStaging } from "./aot-staging.ts";

const reviewedBrand = Symbol("ReviewedPackage");
const preparedBrand = Symbol("PreparedPackage");
export interface ReviewedPackage {
  readonly [reviewedBrand]: true;
  readonly slot: string;
}
export interface PreparedPackage {
  readonly [preparedBrand]: true;
  readonly slot: string;
  readonly artifactSetId: string | null;
}
interface Ready {
  readonly reviewed: ReviewedPackage;
  readonly expected: GenerationExpectation;
  readonly directory: string | null;
  readonly descriptor: ArtifactDescriptor | null;
  readonly owners: GenerationOwners;
}
export interface PreparedDetails {
  readonly snapshot: PackageSnapshot;
  readonly directory: string | null;
  readonly descriptor: ArtifactDescriptor | null;
}
export interface GenerationPin extends PreparedDetails {
  /** Caller releases only after admission cancellation or owned process exit. */
  release(): void;
}

/**
 * Trusted application API, never a guest broker. The caller holds the exclusive
 * profile/store lock for this instance's lifetime; do not create competing owners.
 * `directory` is module-packages, not a package or assets directory.
 */
export class AotStore {
  #snapshots = new Map<ReviewedPackage, PackageSnapshot>();
  #prepared = new Map<PreparedPackage, Ready>();
  #owners = new Map<string, GenerationOwners>();
  #snapshotOwners = new Map<string, GenerationOwners>();
  #staging: StagingArea;
  private constructor(readonly directory: string) {
    this.#staging = new StagingArea(join(directory, "aot"));
  }

  static async open(directory: string): Promise<AotStore> {
    await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await Deno.lstat(directory);
    invariant(info.isDirectory && !info.isSymlink, "Invalid app-owned store root");
    const root = await Deno.realPath(directory);
    for (const relative of ["packages", "aot", "aot/staging", "aot/generations"]) {
      const path = join(root, relative);
      await Deno.mkdir(path, { recursive: true, mode: 0o700 });
      const stat = await Deno.lstat(path);
      invariant(stat.isDirectory && !stat.isSymlink, "Invalid app-owned storage directory");
    }
    return new AotStore(root);
  }

  async review(directory: string, signal = new AbortController().signal): Promise<ReviewedPackage> {
    const source = await Deno.realPath(directory);
    invariant(!contains(source, this.directory) && !contains(this.directory, source), "Package overlaps private storage");
    const slot = crypto.randomUUID();
    const destination = join(this.directory, "packages", slot);
    await copyReviewedPackage(directory, destination, signal);
    try {
      const reviewed = await this.restore(slot);
      await syncDirectory(join(this.directory, "packages"));
      return reviewed;
    } catch (error) {
      await removeOwned(destination);
      throw error;
    }
  }

  /** Only a trusted committed registry supplies this slot; this never imports receipts. */
  async restore(slot: string): Promise<ReviewedPackage> {
    slotId(slot);
    return await this.#use(slot, async () => {
      const path = join(this.directory, "packages", slot);
      await privateDirectory(this.directory, path);
      const snapshot = await inspectSnapshot(path, slot);
      const handle: ReviewedPackage = Object.freeze({ [reviewedBrand]: true as const, slot });
      this.#snapshots.set(handle, snapshot);
      return handle;
    });
  }

  /**
   * Restore only references read from an app-owned committed registry/index.
   * Recorded producer metadata is not current-engine approval: host readiness
   * independently checks the executable. No metadata child or compiler runs here.
   */
  async restorePrepared(slot: string, artifactSet: string | null): Promise<PreparedPackage> {
    const reviewed = await this.restore(slot);
    if (artifactSet === null) {
      return await this.lookup(reviewed, { artifactSetId: null, producers: [] });
    }
    const id = digest(artifactSet);
    return await this.#use(slot, async () => {
      const directory = join(this.directory, "aot", "generations", slot, id);
      await privateDirectory(this.directory, directory);
      const path = join(directory, "descriptor.json");
      await regularPath(directory, path);
      const bytes = await readBounded(path, AOT_LIMITS.descriptor);
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof TypeError) {
          throw new AotError("invalid", "Malformed artifact descriptor");
        }
        throw error;
      }
      const descriptor = parseDescriptor(value);
      // lookup rechecks canonical bytes/digest, exact sources, every object and
      // all private paths; reading metadata above grants no bypass of that seam.
      return await this.lookup(reviewed, {
        artifactSetId: id, producers: descriptor.targets.map((t) => t.producer),
      });
    });
  }

  async #use<T>(slot: string, action: () => Promise<T>): Promise<T> {
    const owners = this.#snapshotOwners.get(slot) ?? new GenerationOwners();
    this.#snapshotOwners.set(slot, owners);
    const release = owners.acquire("pin");
    try { return await action(); } finally { release(); }
  }

  #snapshot(reviewed: ReviewedPackage): PackageSnapshot {
    const snapshot = this.#snapshots.get(reviewed);
    if (!snapshot) throw new AotError("ownership", "Unknown reviewed package capability");
    return snapshot;
  }

  snapshot(reviewed: ReviewedPackage): PackageSnapshot {
    return structuredClone(this.#snapshot(reviewed));
  }

  #expect(reviewed: ReviewedPackage, producers: readonly ArtifactProducer[]): GenerationExpectation {
    const snapshot = this.#snapshot(reviewed);
    invariant(producers.length === snapshot.targets.length, "Expected one producer per declared target");
    return { snapshot, producers: Object.freeze(producers.map(parseProducer)) };
  }

  async stage(reviewed: ReviewedPackage, producers: readonly ArtifactProducer[]): Promise<AotStaging> {
    const expected = this.#expect(reviewed, producers);
    return await this.#use(reviewed.slot, async () => {
      await validateSnapshot(expected.snapshot);
      return await this.#staging.create(expected);
    });
  }

  async publish(stage: AotStaging): Promise<PreparedPackage> {
    return await this.#use(this.#staging.slot(stage), async () => {
      const published = await this.#staging.publish(stage);
      const reviewed = [...this.#snapshots.keys()].find((s) => s.slot === published.descriptor.slot);
      invariant(reviewed, "Published snapshot ownership lost");
      return this.#ready(reviewed, {
        expected: this.#expect(reviewed, published.descriptor.targets.map((t) => t.producer)),
        directory: published.directory, descriptor: published.descriptor,
      });
    });
  }

  async lookup(
    reviewed: ReviewedPackage,
    reference: { readonly artifactSetId: string | null; readonly producers: readonly ArtifactProducer[] },
  ): Promise<PreparedPackage> {
    const expected = this.#expect(reviewed, reference.producers);
    return await this.#use(reviewed.slot, async () => {
    if (expected.snapshot.targets.length === 0) {
      invariant(reference.artifactSetId === null, "Pure Deno/theme packages cannot claim native generations");
      await validateSnapshot(expected.snapshot);
      return this.#ready(reviewed, { expected, directory: null, descriptor: null });
    }
    const id = digest(reference.artifactSetId);
    const directory = join(this.directory, "aot", "generations", reviewed.slot, id);
    await privateDirectory(this.directory, directory);
    const descriptor = await validateGeneration(directory, { ...expected, artifactSetId: id });
    return this.#ready(reviewed, { expected, directory, descriptor });
    });
  }

  #ready(reviewed: ReviewedPackage, data: Omit<Ready, "reviewed" | "owners">): PreparedPackage {
    const id = data.descriptor ? artifactSetId(data.descriptor) : null;
    const key = `${reviewed.slot}/${id ?? "source"}`;
    const owners = this.#owners.get(key) ?? new GenerationOwners();
    owners.acquire("pin")();
    this.#owners.set(key, owners);
    const handle: PreparedPackage = Object.freeze({ [preparedBrand]: true as const, slot: reviewed.slot, artifactSetId: id });
    this.#prepared.set(handle, { ...data, reviewed, owners });
    return handle;
  }

  #get(prepared: PreparedPackage): Ready {
    const ready = this.#prepared.get(prepared);
    if (!ready) throw new AotError("ownership", "Unknown prepared package capability");
    return ready;
  }

  details(prepared: PreparedPackage): PreparedDetails {
    const ready = this.#get(prepared);
    return structuredClone({ snapshot: ready.expected.snapshot, directory: ready.directory, descriptor: ready.descriptor });
  }

  artifactBytes(prepared: PreparedPackage): number {
    const descriptor = this.#get(prepared).descriptor;
    return descriptor?.targets.reduce(
      (bytes, target) => bytes + target.artifact.size,
      0,
    ) ?? 0;
  }

  async pin(prepared: PreparedPackage): Promise<GenerationPin> {
    const ready = this.#get(prepared);
    const release = ready.owners.acquire("pin");
    try {
      if (ready.directory && prepared.artifactSetId) {
        await privateDirectory(this.directory, ready.directory);
        await validateGeneration(ready.directory, { ...ready.expected, artifactSetId: prepared.artifactSetId });
      } else await validateSnapshot(ready.expected.snapshot);
      return { ...this.details(prepared), release };
    } catch (error) {
      release();
      throw error;
    }
  }

  /** Hold from committed registry reference creation until its replacement/removal. */
  retain(prepared: PreparedPackage): { release(): void } {
    return { release: this.#get(prepared).owners.acquire("reference") };
  }

  async reclaim(prepared: PreparedPackage): Promise<void> {
    const ready = this.#get(prepared);
    ready.owners.beginReclaim();
    try {
      if (ready.directory) {
        await privateDirectory(this.directory, ready.directory);
        await removeOwned(ready.directory);
        await syncDirectory(join(this.directory, "aot", "generations", prepared.slot));
      }
      for (const [handle, item] of this.#prepared) {
        if (item.owners === ready.owners) this.#prepared.delete(handle);
      }
    } catch (error) {
      ready.owners.failedReclaim();
      throw error;
    }
  }

  async discardReviewed(reviewed: ReviewedPackage): Promise<void> {
    const snapshot = this.#snapshot(reviewed);
    if (this.#staging.ownsSlot(reviewed.slot) || [...this.#prepared.keys()].some((p) => p.slot === reviewed.slot)) {
      throw new AotError("in-use", "Snapshot still has prepared generations or staging owners");
    }
    const owners = this.#snapshotOwners.get(reviewed.slot);
    invariant(owners, "Unknown snapshot ownership");
    owners.beginReclaim();
    try {
      await privateDirectory(this.directory, snapshot.package.root);
      await removeOwned(snapshot.package.root);
    } catch (error) {
      owners.failedReclaim();
      throw error;
    }
    for (const handle of this.#snapshots.keys()) {
      if (handle.slot === reviewed.slot) this.#snapshots.delete(handle);
    }
    await syncDirectory(join(this.directory, "packages"));
  }

  discardStage(stage: AotStaging): Promise<void> { return this.#staging.discard(stage); }
  orphanStagingIds(): Promise<readonly string[]> { return this.#staging.orphanIds(); }
  discardOrphanStaging(id: string): Promise<void> { return this.#staging.discardOrphan(id); }
}
