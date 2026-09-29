import { createMemo, createSignal } from "solid-js";
import {
  effectivePreferences,
  type PreferenceKey,
  type PreferenceLayer,
  type PreferenceRecord,
  type Preferences,
  type PreferenceScope,
  type PreferenceSnapshot,
  validateLayer,
  validatePreference,
} from "../../../src/shared/preferences.ts";
import { readPreferredTheme } from "../themes/apply";
import type { Json } from "../../../modules-sdk/js/mod.ts";

export function createPreferences(notify: (message: string) => void) {
  let initial: PreferenceLayer = { theme: readPreferredTheme() };
  try {
    const raw = localStorage.getItem("maghemite.preferences.v1");
    if (raw) initial = validateLayer(JSON.parse(raw));
  } catch { /* Invalid preview settings use defaults. */ }
  const [user, setUser] = createSignal<PreferenceRecord>({
    values: initial,
    version: null,
  });
  const [workspace, setWorkspace] = createSignal<PreferenceRecord>({
    values: {},
    version: null,
  });
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [desktop, setDesktop] = createSignal(false);
  const [connected, setConnected] = createSignal(false);
  let remote: ((parameters: Json) => Promise<Json>) | undefined;
  const effective = createMemo(() =>
    effectivePreferences(user().values, workspace().values)
  );
  async function update(
    key: PreferenceKey,
    value: Preferences[PreferenceKey] | undefined,
    scope: PreferenceScope,
  ) {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      if (value !== undefined) validatePreference(key, value);
      if (desktop() && !remote) {
        throw new Error(
          "Reconnect to save settings. Current preferences are retained.",
        );
      }
      const current = scope === "user" ? user() : workspace();
      let saved: PreferenceRecord;
      if (remote) {
        saved = await remote({
          key,
          scope,
          version: current.version,
          ...(value === undefined ? { reset: true } : { value }),
        }) as unknown as PreferenceRecord;
      } else {
        if (scope !== "user") {
          throw new Error("Open a desktop workspace for project settings");
        }
        const values = { ...current.values };
        if (value === undefined) delete values[key];
        else Object.assign(values, { [key]: value });
        localStorage.setItem(
          "maghemite.preferences.v1",
          JSON.stringify(values),
        );
        saved = { values, version: null };
      }
      (scope === "user" ? setUser : setWorkspace)(saved);
      notify("Settings saved");
    } catch (e) {
      setError(String(e));
      notify(String(e));
    } finally {
      setBusy(false);
    }
  }
  return {
    effective,
    user,
    workspace,
    busy,
    error,
    desktop,
    connected,
    update,
    connect(
      snapshot: PreferenceSnapshot,
      request: (parameters: Json) => Promise<Json>,
    ) {
      setUser({
        ...snapshot.user,
        values: validateLayer(snapshot.user.values),
      });
      setWorkspace({
        ...snapshot.workspace,
        values: validateLayer(snapshot.workspace.values),
      });
      remote = request;
      setDesktop(true);
      setConnected(true);
      setError("");
    },
    disconnect() {
      remote = undefined;
      setConnected(false);
    },
  };
}
export type WorkbenchPreferences = ReturnType<typeof createPreferences>;
