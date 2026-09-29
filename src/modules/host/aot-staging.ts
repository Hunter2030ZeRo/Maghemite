import { join } from "node:path";
import { type ArtifactDescriptor, AotError } from "../../shared/module_aot.ts";
import { artifactSetId, invariant, slotId } from "./aot-schema.ts";
import { privateDirectory, removeOwned, syncDirectory, writeSynced } from "./aot-files.ts";
import {
  type GenerationExpectation, sealGeneration, validateGeneration, withStagingLease,
} from "./aot-generation.ts";

const stagingBrand = Symbol("AotStaging");
export interface AotStaging {
  readonly [stagingBrand]: true;
  readonly id: string;
  readonly directory: string;
  readonly lockPath: string;
}
interface Stage {
  readonly expected: GenerationExpectation;
  busy: boolean;
}
export interface PublishedGeneration {
  readonly directory: string;
  readonly descriptor: ArtifactDescriptor;
}

/** Only this store's live stage capability authorizes publication. */
export class StagingArea {
  #stages = new Map<AotStaging, Stage>();
  constructor(readonly root: string) {}

  async create(expected: GenerationExpectation): Promise<AotStaging> {
    invariant(expected.snapshot.targets.length > 0, "No native targets require staging");
    await privateDirectory(this.root, join(this.root, "staging"));
    const id = crypto.randomUUID();
    const directory = join(this.root, "staging", id);
    await Deno.mkdir(directory, { mode: 0o700 });
    try {
      const lockPath = join(directory, "owner.lock");
      await writeSynced(lockPath, new Uint8Array());
      await syncDirectory(directory);
      await syncDirectory(join(this.root, "staging"));
      const handle: AotStaging = Object.freeze({ [stagingBrand]: true as const, id, directory, lockPath });
      this.#stages.set(handle, { expected, busy: false });
      return handle;
    } catch (error) {
      await removeOwned(directory);
      throw error;
    }
  }

  ownsSlot(slot: string): boolean {
    return [...this.#stages.values()].some((s) => s.expected.snapshot.slot === slot);
  }

  slot(handle: AotStaging): string {
    const stage = this.#stages.get(handle);
    if (!stage) throw new AotError("ownership", "Unknown staging capability");
    return stage.expected.snapshot.slot;
  }

  #take(handle: AotStaging): Stage {
    const stage = this.#stages.get(handle);
    if (!stage || stage.busy) throw new AotError("ownership", "Staging capability is unavailable");
    stage.busy = true;
    return stage;
  }

  async publish(handle: AotStaging): Promise<PublishedGeneration> {
    const stage = this.#take(handle);
    try {
      await privateDirectory(this.root, handle.directory);
      return await withStagingLease(handle.directory, async () => {
        const descriptor = await validateGeneration(handle.directory, stage.expected);
        const parent = join(this.root, "generations", descriptor.slot);
        await privateDirectory(this.root, join(this.root, "generations"));
        await Deno.mkdir(parent, { recursive: true, mode: 0o700 });
        await privateDirectory(this.root, parent);
        const directory = join(parent, artifactSetId(descriptor));
        try {
          await Deno.lstat(directory);
          throw new AotError("ownership", "Generation already exists; immutable objects cannot be overwritten");
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        await sealGeneration(handle.directory);
        await Deno.rename(handle.directory, directory);
        this.#stages.delete(handle);
        await syncDirectory(parent);
        await syncDirectory(join(this.root, "generations"));
        await syncDirectory(join(this.root, "staging"));
        return { directory, descriptor };
      });
    } finally {
      stage.busy = false;
    }
  }

  async discard(handle: AotStaging): Promise<void> {
    const stage = this.#take(handle);
    try {
      await privateDirectory(this.root, handle.directory);
      await withStagingLease(handle.directory, () => removeOwned(handle.directory));
      this.#stages.delete(handle);
      await syncDirectory(join(this.root, "staging"));
    } finally {
      stage.busy = false;
    }
  }

  async orphanIds(): Promise<readonly string[]> {
    await privateDirectory(this.root, join(this.root, "staging"));
    const live = new Set([...this.#stages.keys()].map((s) => s.id));
    const ids: string[] = [];
    for await (const entry of Deno.readDir(join(this.root, "staging"))) {
      slotId(entry.name);
      invariant(entry.isDirectory && !entry.isSymlink, "Invalid staging directory");
      if (!live.has(entry.name)) ids.push(entry.name);
    }
    return ids.sort();
  }

  /** Caller charges orphan preparation admission before waiting for this lease. */
  async discardOrphan(id: string): Promise<void> {
    slotId(id);
    invariant(![...this.#stages.keys()].some((s) => s.id === id), "Live stage is not an orphan");
    const directory = join(this.root, "staging", id);
    await privateDirectory(this.root, directory);
    // A crash before owner.lock creation grants no native child writing authority.
    try {
      await Deno.lstat(join(directory, "owner.lock"));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      await removeOwned(directory);
      return;
    }
    await withStagingLease(directory, () => removeOwned(directory));
    await syncDirectory(join(this.root, "staging"));
  }
}
