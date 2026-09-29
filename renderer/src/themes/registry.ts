import { isThemeId } from '../../../modules-sdk/themes/mod.ts'

/** Theme data owns appearance and font families. Layout, sizes and line heights stay in the workbench. */
export const colorTokens = [
  '--bg',
  '--sidebar',
  '--rail',
  '--top',
  '--surface',
  '--hover',
  '--selected',
  '--line',
  '--subtle-line',
  '--text',
  '--bright',
  '--muted',
  '--faint',
  '--accent',
  '--accent-wash',
  '--code-icon',
  '--selection',
  '--selection-text',
  '--scrollbar-thumb',
  '--dialog-overlay',
  '--dialog-shadow',
  '--drawer-overlay',
  '--drawer-shadow',
  '--warning-bg',
  '--warning-text',
  '--syntax-keyword',
  '--syntax-type',
  '--syntax-function',
  '--syntax-variable',
  '--syntax-string',
  '--syntax-number',
  '--syntax-comment',
  '--syntax-operator',
] as const
export const shapeTokens = [
  '--radius-xs',
  '--radius-sm',
  '--radius-md',
  '--radius-lg',
  '--radius-dialog',
  '--radius-identity',
  '--radius-tab',
  '--radius-round',
] as const

export type ThemeColors = Record<typeof colorTokens[number], string>
export type ThemeShape = Record<typeof shapeTokens[number], string>
export const fontTokens = [
  '--font-ui',
  '--font-code',
  '--font-note',
  '--font-heading',
  '--font-display',
  '--font-subheading',
  '--font-graph',
] as const
export type ThemeFonts = Record<typeof fontTokens[number], string>
export type ThemeId = string
export interface ThemeDefinition {
  id: ThemeId
  name: string
  description: string
  colorScheme: 'dark' | 'light'
  colors: ThemeColors
  shape: ThemeShape
  fonts: ThemeFonts
}

/** Preserve the approved faces exactly; private variants keep each surface's old fallback. */
const defaultFonts: ThemeFonts = {
  '--font-ui': '"IBM Plex Sans", "Segoe UI", system-ui, sans-serif',
  '--font-code':
    '"IBM Plex Mono", "Cascadia Code", "DejaVu Sans Mono", monospace',
  '--font-note': 'var(--font-ui)',
  '--font-heading': 'Georgia, "Noto Serif", serif',
  '--font-display': 'Georgia, serif',
  '--font-subheading': 'var(--font-note)',
  '--font-graph': 'system-ui',
}

const angular: ThemeShape = {
  '--radius-xs': '0px',
  '--radius-sm': '0px',
  '--radius-md': '0px',
  '--radius-lg': '2px',
  '--radius-dialog': '2px',
  '--radius-identity': '0px',
  '--radius-tab': '0px',
  '--radius-round': '50%',
}
const rounded: ThemeShape = {
  '--radius-xs': '3px',
  '--radius-sm': '5px',
  '--radius-md': '8px',
  '--radius-lg': '10px',
  '--radius-dialog': '12px',
  '--radius-identity': '9px',
  '--radius-tab': '8px 8px 0 0',
  '--radius-round': '50%',
}
const graphite: ThemeColors = {
  '--bg': '#202426',
  '--sidebar': '#1c2022',
  '--rail': '#181c1e',
  '--top': '#181c1e',
  '--surface': '#272c2e',
  '--hover': '#2e3436',
  '--selected': '#303a36',
  '--line': '#343a3c',
  '--subtle-line': '#2b3133',
  '--text': '#d6dcd9',
  '--bright': '#eef0e9',
  '--muted': '#8e9b96',
  '--faint': '#829088',
  '--accent': '#afc6ad',
  '--accent-wash': '#b3d3b514',
  '--code-icon': '#92b1c2',
  '--selection': '#547266',
  '--selection-text': '#f4f7f0',
  '--scrollbar-thumb': '#7d85843d',
  '--dialog-overlay': '#0a101080',
  '--dialog-shadow': '#070d0d99',
  '--drawer-overlay': '#0b111170',
  '--drawer-shadow': '#0b111140',
  '--warning-bg': '#6e522b',
  '--warning-text': '#fff5df',
  '--syntax-keyword': '#569cd6',
  '--syntax-type': '#4ec9b0',
  '--syntax-function': '#dcdcaa',
  '--syntax-variable': '#9cdcfe',
  '--syntax-string': '#ce9178',
  '--syntax-number': '#b5cea8',
  '--syntax-comment': '#6a9955',
  '--syntax-operator': '#d6dcd9',
}

/** Presets provide the complete color/shape/font contract, never component CSS overrides. */
export const themes: readonly ThemeDefinition[] = [
  {
    id: 'graphite',
    name: 'Graphite',
    description: 'Deep black · square corners · default',
    colorScheme: 'dark',
    fonts: { ...defaultFonts },
    colors: graphite,
    shape: angular,
  },
  {
    id: 'soft-charcoal',
    name: 'Soft charcoal',
    description: 'Lighter charcoal · rounded corners',
    colorScheme: 'dark',
    fonts: { ...defaultFonts },
    shape: rounded,
    colors: {
      '--bg': '#2a2b2e',
      '--sidebar': '#252629',
      '--rail': '#222326',
      '--top': '#222326',
      '--surface': '#323437',
      '--hover': '#3b3d40',
      '--selected': '#3a433e',
      '--line': '#414346',
      '--subtle-line': '#35373a',
      '--text': '#dedfdc',
      '--bright': '#f1f1eb',
      '--muted': '#a3aaa5',
      '--faint': '#939d95',
      '--accent': '#b8cdb4',
      '--accent-wash': '#c1d9ba14',
      '--code-icon': '#a9c1d0',
      '--selection': '#587460',
      '--selection-text': '#f6f8f2',
      '--scrollbar-thumb': '#a8afa84a',
      '--dialog-overlay': '#15151980',
      '--dialog-shadow': '#11121680',
      '--drawer-overlay': '#15151966',
      '--drawer-shadow': '#11121640',
      '--warning-bg': '#745c35',
      '--warning-text': '#fff5df',
      '--syntax-keyword': '#569cd6',
      '--syntax-type': '#4ec9b0',
      '--syntax-function': '#dcdcaa',
      '--syntax-variable': '#9cdcfe',
      '--syntax-string': '#ce9178',
      '--syntax-number': '#b5cea8',
      '--syntax-comment': '#6a9955',
      '--syntax-operator': '#d6dcd9',
    },
  },
  {
    id: 'daylight',
    name: 'Daylight',
    description: 'Light surfaces · square corners',
    colorScheme: 'light',
    fonts: { ...defaultFonts },
    shape: angular,
    colors: {
      '--bg': '#fafaf7',
      '--sidebar': '#f1f3ee',
      '--rail': '#e9ede6',
      '--top': '#eef0eb',
      '--surface': '#e5e9e1',
      '--hover': '#e0e7dc',
      '--selected': '#dce6d6',
      '--line': '#cdd4c9',
      '--subtle-line': '#e0e5dc',
      '--text': '#424c43',
      '--bright': '#1e2e23',
      '--muted': '#606e62',
      '--faint': '#667564',
      '--accent': '#426d42',
      '--accent-wash': '#56795012',
      '--code-icon': '#42667c',
      '--selection': '#c0d7b6',
      '--selection-text': '#17251a',
      '--scrollbar-thumb': '#5d715a55',
      '--dialog-overlay': '#26332540',
      '--dialog-shadow': '#24372330',
      '--drawer-overlay': '#26332540',
      '--drawer-shadow': '#24372325',
      '--warning-bg': '#f3dfb9',
      '--warning-text': '#58401a',
      '--syntax-keyword': '#0000ff',
      '--syntax-type': '#267f99',
      '--syntax-function': '#795e26',
      '--syntax-variable': '#001080',
      '--syntax-string': '#a31515',
      '--syntax-number': '#098658',
      '--syntax-comment': '#008000',
      '--syntax-operator': '#424c43',
    },
  },
]

export const DEFAULT_THEME_ID: ThemeId = 'graphite'
export function getTheme(
  id: unknown,
  available: readonly ThemeDefinition[] = themes,
): ThemeDefinition {
  return available.find((theme) => theme.id === id) ?? themes[0]
}
export function themeVariables(
  theme: ThemeDefinition,
): ThemeColors & ThemeShape & ThemeFonts {
  return { ...theme.colors, ...theme.shape, ...theme.fonts }
}

export const THEME_STORAGE_KEY = 'maghemite.appearance.v1'
export function decodeThemePreference(raw: string | null): ThemeId {
  if (!raw || raw.length > 256) return DEFAULT_THEME_ID
  try {
    const value = JSON.parse(raw)
    return value?.version === 1 && validPreferenceId(value.themeId)
      ? value.themeId
      : DEFAULT_THEME_ID
  } catch {
    return DEFAULT_THEME_ID
  }
}
function validPreferenceId(id: unknown): id is ThemeId {
  return themes.some((theme) => theme.id === id) || isThemeId(id)
}
export function loadThemePreference(
  storage: Pick<Storage, 'getItem'>,
): ThemeId {
  try {
    return decodeThemePreference(storage.getItem(THEME_STORAGE_KEY))
  } catch {
    return DEFAULT_THEME_ID
  }
}
export function saveThemePreference(
  storage: Pick<Storage, 'setItem'>,
  id: ThemeId,
): boolean {
  try {
    storage.setItem(
      THEME_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        themeId: validPreferenceId(id) ? id : DEFAULT_THEME_ID,
      }),
    )
    return true
  } catch {
    return false
  }
}
