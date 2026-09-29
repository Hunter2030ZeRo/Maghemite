import { join } from "node:path";
import { SettingsStore } from "../core/services/settings.ts";
import {
  isPreferenceKey,
  type PreferenceRecord,
  type PreferenceScope,
  type PreferenceSnapshot,
  validateLayer,
  validatePreference,
} from "../shared/preferences.ts";
import type { Json } from "../../modules-sdk/js/mod.ts";

/** Kept outside the module namespace: extensions cannot impersonate application settings. */
export class WorkbenchPreferences {
  #store: SettingsStore;
  #queue: Promise<unknown> = Promise.resolve();
  constructor(directory: string) {
    this.#store = new SettingsStore(join(directory, "preferences"));
  }
  async #read(key: string): Promise<PreferenceRecord> {
    const record = await this.#store.request(
      "settings",
      "get",
      "maghemite.workbench",
      { key },
    ) as { value: Json; version: string | null };
    return {
      values: record.version === null ? {} : validateLayer(record.value),
      version: record.version,
    };
  }
  async get(workspaceId: string | null): Promise<PreferenceSnapshot> {
    return {
      user: await this.#read("user"),
      workspace: workspaceId
        ? await this.#read(`workspace-${workspaceId}`)
        : { values: {}, version: null },
    };
  }
  update(
    workspaceId: string | null,
    p: Record<string, Json>,
    signal: AbortSignal,
  ) {
    const work = this.#queue.then(async () => {
      signal.throwIfAborted();
      if (p.scope !== "user" && p.scope !== "workspace") {
        throw new Error("Invalid settings scope");
      }
      if (!isPreferenceKey(p.key)) throw new Error("Unknown preference");
      if (p.scope === "workspace" && !workspaceId) {
        throw new Error("Open a workspace first");
      }
      const scope = p.scope as PreferenceScope;
      const key = scope === "user" ? "user" : `workspace-${workspaceId}`;
      const current = await this.#read(key);
      if (p.version !== current.version) {
        throw new Error(
          "Settings changed elsewhere. Reconnect to reload them.",
        );
      }
      const values = { ...current.values };
      if (p.reset === true) delete values[p.key];
      else {
        validatePreference(p.key, p.value);
        Object.assign(values, { [p.key]: p.value });
      }
      const saved = await this.#store.request(
        "settings",
        "set",
        "maghemite.workbench",
        {
          key,
          value: values as Json,
          version: current.version,
        },
        signal,
      ) as { version: string };
      return { values, version: saved.version };
    });
    this.#queue = work.catch(() => {});
    return work;
  }
}
