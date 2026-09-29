import {
  MAX_CATALOG_BYTES,
  type ThemeColorName,
  type ThemeFontName,
  type ThemeRadiusName,
  validateThemeCatalog,
} from '../../../modules-sdk/themes/mod.ts'
import {
  getTheme,
  type ThemeColors,
  type ThemeDefinition,
  type ThemeFonts,
  themes,
  type ThemeShape,
} from './registry.ts'

/** CSS names are renderer-private. SDK authors use stable semantic token names. */
const colors: Record<ThemeColorName, keyof ThemeColors> = {
  'surface.background': '--bg',
  'sidebar.background': '--sidebar',
  'activity.background': '--rail',
  'titlebar.background': '--top',
  'control.background': '--surface',
  'control.hover': '--hover',
  'control.selected': '--selected',
  'border.default': '--line',
  'border.subtle': '--subtle-line',
  'text.default': '--text',
  'text.bright': '--bright',
  'text.muted': '--muted',
  'text.faint': '--faint',
  'accent.default': '--accent',
  'accent.background': '--accent-wash',
  'icon.code': '--code-icon',
  'selection.background': '--selection',
  'selection.foreground': '--selection-text',
  'scrollbar.thumb': '--scrollbar-thumb',
  'dialog.overlay': '--dialog-overlay',
  'dialog.shadow': '--dialog-shadow',
  'drawer.overlay': '--drawer-overlay',
  'drawer.shadow': '--drawer-shadow',
  'warning.background': '--warning-bg',
  'warning.foreground': '--warning-text',
  'syntax.keyword': '--syntax-keyword',
  'syntax.type': '--syntax-type',
  'syntax.function': '--syntax-function',
  'syntax.variable': '--syntax-variable',
  'syntax.string': '--syntax-string',
  'syntax.number': '--syntax-number',
  'syntax.comment': '--syntax-comment',
  'syntax.operator': '--syntax-operator',
}
const radii: Record<ThemeRadiusName, keyof ThemeShape> = {
  'radius.xs': '--radius-xs',
  'radius.small': '--radius-sm',
  'radius.medium': '--radius-md',
  'radius.large': '--radius-lg',
  'radius.dialog': '--radius-dialog',
  'radius.identity': '--radius-identity',
  'radius.tab': '--radius-tab',
}
const fonts: Record<ThemeFontName, readonly (keyof ThemeFonts)[]> = {
  'font.ui': ['--font-ui', '--font-graph'],
  'font.code': ['--font-code'],
  'font.note': ['--font-note'],
  'font.heading': ['--font-heading', '--font-display', '--font-subheading'],
}
const genericFamilies = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
])
function fontFamilyList(names: string[]) {
  // Only validated names reach here. Quote normal family names, including Unicode names.
  return names.map((name) => genericFamilies.has(name) ? name : `"${name}"`)
    .join(', ')
}

export function resolveThemeCatalog(
  value: unknown,
): readonly ThemeDefinition[] {
  const catalog = validateThemeCatalog(value)
  return [
    ...themes,
    ...catalog.themes.map((entry): ThemeDefinition => {
      const base = getTheme(entry.theme.base)
      const resolved: ThemeDefinition = {
        ...base,
        id: entry.id,
        name: entry.label,
        description: `From ${entry.moduleId}`,
        colors: { ...base.colors },
        shape: { ...base.shape },
        fonts: { ...base.fonts },
      }
      for (const [name, color] of Object.entries(entry.theme.colors ?? {})) {
        resolved.colors[colors[name as ThemeColorName]] = color
      }
      for (const [name, radius] of Object.entries(entry.theme.shape ?? {})) {
        const values = Array.isArray(radius) ? radius : [radius]
        resolved.shape[radii[name as ThemeRadiusName]] = values.map((v) =>
          `${v}px`
        ).join(' ')
      }
      for (const [name, families] of Object.entries(entry.theme.fonts ?? {})) {
        for (const token of fonts[name as ThemeFontName]) {
          resolved.fonts[token] = `${fontFamilyList(families)}, ${
            base.fonts[token]
          }`
        }
      }
      return resolved
    }),
  ]
}

/** Same-origin transport only; the theme engine itself does not depend on HTTP. */
export async function fetchThemeCatalog(
  url: string,
  signal: AbortSignal,
): Promise<readonly ThemeDefinition[]> {
  const target = new URL(url, window.location.href)
  if (target.origin !== window.location.origin) {
    throw new Error('Theme catalog must be same-origin')
  }
  const response = await fetch(target, {
    signal,
    cache: 'no-store',
    redirect: 'error',
  })
  if (
    !response.ok ||
    !response.headers.get('content-type')?.includes('application/json') ||
    !response.body
  ) {
    throw new Error('Theme catalog is unavailable')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let size = 0
  let json = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_CATALOG_BYTES) {
        throw new Error('Theme catalog is too large')
      }
      json += decoder.decode(value, { stream: true })
    }
    json += decoder.decode()
    return resolveThemeCatalog(JSON.parse(json))
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
