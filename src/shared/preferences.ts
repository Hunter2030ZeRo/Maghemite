/** Shared, validated application settings. Modules keep their own settings namespaces. */
export const preferenceDefaults = {
  theme: "graphite",
  uiFont: "",
  editorFont: "",
  noteFont: "",
  editorFontSize: 12,
  editorLineHeight: 24,
  noteFontSize: 13,
  tabSize: 2,
  wordWrap: false,
  lineNumbers: true,
  autoSave: false,
  autoSaveDelay: 1000,
  confirmClose: true,
  noteView: "read" as "read" | "edit",
};
export type Preferences = typeof preferenceDefaults;
export type PreferenceKey = keyof Preferences;
export type PreferenceLayer = Partial<Preferences>;
export type PreferenceScope = "user" | "workspace";
export interface PreferenceRecord {
  values: PreferenceLayer;
  version: string | null;
}
export interface PreferenceSnapshot {
  user: PreferenceRecord;
  workspace: PreferenceRecord;
}
export function isPreferenceKey(key: unknown): key is PreferenceKey {
  return typeof key === "string" && Object.hasOwn(preferenceDefaults, key);
}
export function validatePreference(key: PreferenceKey, value: unknown): void {
  const bounds: Partial<Record<PreferenceKey, [number, number]>> = {
    editorFontSize: [10, 32],
    editorLineHeight: [16, 48],
    noteFontSize: [10, 28],
    tabSize: [1, 8],
    autoSaveDelay: [500, 30000],
  };
  const range = bounds[key];
  const valid = range
    ? Number.isInteger(value) && Number(value) >= range[0] &&
      Number(value) <= range[1]
    : key === "theme"
    ? typeof value === "string" && /^[a-z][a-z0-9._-]{0,127}$/.test(value)
    : key === "noteView"
    ? value === "read" || value === "edit"
    : key.endsWith("Font")
    ? typeof value === "string" && value.length <= 200 &&
      !/[;{}<>\\\r\n\x00-\x1f]/.test(value) && !/(?:url|var)\s*\(/i.test(value)
    : typeof value === "boolean";
  if (!valid) throw new Error(`Invalid preference: ${key}`);
}
export function validateLayer(value: unknown): PreferenceLayer {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid preference layer");
  }
  const result: Record<string, unknown> = {};
  for (const [key, setting] of Object.entries(value)) {
    if (!isPreferenceKey(key)) throw new Error(`Unknown preference: ${key}`);
    validatePreference(key, setting);
    result[key] = setting;
  }
  return result as PreferenceLayer;
}
export function effectivePreferences(
  user: PreferenceLayer,
  workspace: PreferenceLayer,
): Preferences {
  return { ...preferenceDefaults, ...user, ...workspace };
}
