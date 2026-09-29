import { basename, dirname, join } from "node:path";
import type { ModuleHost } from "../modules/host/host.ts";
import type { ModuleManifest } from "../modules/host/manifest.ts";
import type {
  ModulePage,
  ModuleResources,
  ModuleStatus,
  ResourceSnapshot,
} from "../shared/module_resources.ts";
import type { InstalledRecord } from "./module_installation_registry.ts";
import type { InstallationPackages } from "./module_installation_packages.ts";

export function moduleSummary(manifest: ModuleManifest) {
  return {
    id: manifest.id,
    version: manifest.version,
    runtime: manifest.runtime ?? "theme",
    capabilities: manifest.capabilities,
    commands: manifest.contributions.commands.length,
    themes: manifest.contributions.themes.length,
    languageFeatures: [
      ...new Set((manifest.contributions.languages ?? []).flatMap((language) =>
        language.features
      )),
    ],
  };
}
export async function installationPage(
  host: ModuleHost,
  records: readonly InstalledRecord[],
  packages: InstallationPackages,
  options: {
    readonly offset: number;
    readonly errors: ReadonlyMap<string, string>;
  },
): Promise<ModulePage> {
  const resources = await host.resources.snapshot();
  const installedAot = await Promise.all(records.map((record) =>
    packages.artifactBytes(record)
  ));
  const diskBySlot = new Map(
    records.map((record, index) => [record.slot, installedAot[index] ?? null]),
  );
  const usage = (
    id: string,
    record?: InstalledRecord,
    manifest?: ModuleManifest,
  ): ModuleResources =>
    moduleResources(host, resources, {
      id,
      manifest,
      installedAotBytes: record ? diskBySlot.get(record.slot) ?? null : null,
    });
  const installed: ModuleStatus[] = host.list().map(
    ({ manifest, state, error, busy, grants }) => {
      const record = records.find((item) => item.id === manifest.id);
      return {
        ...moduleSummary(manifest),
        state,
        busy,
        grants,
        managed: !!record,
        enabled: record?.enabled ?? state !== "disabled",
        error: error ?? options.errors.get(manifest.id) ?? null,
        resources: usage(manifest.id, record, manifest),
      };
    },
  );
  for (const [id, error] of options.errors) {
    if (installed.some((item) => item.id === id)) continue;
    const record = records.find((item) => item.id === id);
    installed.push({
      id,
      error,
      version: "unknown",
      runtime: "unknown",
      capabilities: [],
      languageFeatures: [],
      commands: 0,
      themes: 0,
      state: "failed",
      managed: true,
      busy: false,
      enabled: record?.enabled ?? true,
      grants: record?.grants ?? [],
      resources: usage(id, record),
    });
  }
  return {
    items: installed.slice(options.offset, options.offset + 10),
    nextOffset: options.offset + 10 < installed.length
      ? options.offset + 10
      : null,
    resources,
    diskUsage: {
      installedAotBytes: installedAot.every((bytes) => bytes !== null)
        ? installedAot.reduce((total, bytes) => total + (bytes ?? 0), 0)
        : null,
      legacyCacheBytes: await legacyCacheBytes(packages.store.directory),
    },
  };
}
function moduleResources(
  host: ModuleHost,
  snapshot: ResourceSnapshot,
  module: {
    readonly id: string;
    readonly manifest?: ModuleManifest;
    readonly installedAotBytes: number | null;
  },
): ModuleResources {
  const processes = snapshot.processes.filter((p) => p.moduleId === module.id);
  return {
    processes,
    queued: host.resources.queued(module.id),
    rssBytes: processes.every((p) => p.rssBytes !== null)
      ? processes.reduce((n, p) => n + (p.rssBytes ?? 0), 0)
      : null,
    reservedBytes: processes.reduce((n, p) => n + p.reservedBytes, 0),
    installedAotBytes: module.installedAotBytes,
    limits: {
      linearMemoryBytes: module.manifest?.runtime === "wasm"
        ? (module.manifest.wasmResources === "compute" ? 256 : 128) * 1048576
        : null,
      memories: module.manifest?.runtime === "wasm" ? 16 : null,
      oldSpaceBytes: module.manifest?.runtime === "deno" ? 128 * 1048576 : null,
      wasiToolMemoryBytes: module.manifest?.wasmTools?.length
        ? 512 * 1048576
        : null,
    },
  };
}

async function legacyCacheBytes(storeDirectory: string): Promise<number | null> {
  if (basename(storeDirectory) !== "module-packages") return null;
  const root = join(dirname(storeDirectory), "wasm-cache");
  try {
    const rootInfo = await Deno.lstat(root);
    if (!rootInfo.isDirectory || rootInfo.isSymlink) return null;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return 0;
    if (error instanceof Error) return null;
    throw error;
  }
  const pending = [root];
  let bytes = 0;
  let entries = 0;
  try {
    while (pending.length) {
      const directory = pending.pop();
      if (directory === undefined) return null;
      for await (const entry of Deno.readDir(directory)) {
        if (++entries > 4096) return null;
        const path = join(directory, entry.name);
        const info = await Deno.lstat(path);
        if (info.isSymlink) return null;
        if (info.isDirectory) pending.push(path);
        else if (info.isFile) {
          bytes += info.size;
          if (!Number.isSafeInteger(bytes)) return null;
        } else return null;
      }
    }
    return bytes;
  } catch (error) {
    if (error instanceof Error) return null;
    throw error;
  }
}
