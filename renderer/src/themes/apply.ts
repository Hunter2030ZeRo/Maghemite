import {
  DEFAULT_THEME_ID,
  loadThemePreference,
  saveThemePreference,
  type ThemeDefinition,
  type ThemeId,
  themeVariables,
} from './registry'

export function readPreferredTheme(): ThemeId {
  try {
    return loadThemePreference(window.localStorage)
  } catch {
    return DEFAULT_THEME_ID
  }
}
export function persistPreferredTheme(id: ThemeId): boolean {
  try {
    return saveThemePreference(window.localStorage, id)
  } catch {
    return false
  }
}

/** Root variables also cover native controls, selection, scrollbars and overlays. */
export function applyTheme(theme: ThemeDefinition, root: HTMLElement) {
  for (const [property, value] of Object.entries(themeVariables(theme))) {
    root.style.setProperty(property, value)
  }
  root.style.colorScheme = theme.colorScheme
  root.dataset.theme = theme.id
}
