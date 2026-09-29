import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict'
import { resolveThemeCatalog } from '../src/themes/catalog.ts'
import {
  colorTokens,
  decodeThemePreference,
  fontTokens,
  getTheme,
  loadThemePreference,
  saveThemePreference,
  shapeTokens,
  THEME_STORAGE_KEY,
  themes,
  themeVariables,
} from '../src/themes/registry.ts'

Deno.test('unknown, malformed and old theme preferences fall back to the default', () => {
  for (
    const raw of [
      null,
      '',
      'not JSON',
      'null',
      '{}',
      JSON.stringify({ version: 2, themeId: 'soft-charcoal' }),
      JSON.stringify({ version: 1, themeId: 'unknown' }),
      ' '.repeat(257),
    ]
  ) {
    strictEqual(decodeThemePreference(raw), 'graphite')
  }
  strictEqual(getTheme(undefined).id, 'graphite')
})
Deno.test('theme preferences survive a storage round trip; blocked storage is recoverable', () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
  }
  strictEqual(saveThemePreference(storage, 'soft-charcoal'), true)
  strictEqual(loadThemePreference(storage), 'soft-charcoal')
  deepStrictEqual(JSON.parse(values.get(THEME_STORAGE_KEY)!), {
    version: 1,
    themeId: 'soft-charcoal',
  })
  strictEqual(
    loadThemePreference({
      getItem: () => {
        throw new Error('Blocked')
      },
    }),
    'graphite',
  )
  strictEqual(
    saveThemePreference({
      setItem: () => {
        throw new Error('Quota')
      },
    }, 'daylight'),
    false,
  )
})
Deno.test('every preset implements the same appearance-only token contract', () => {
  const expected = [...colorTokens, ...shapeTokens, ...fontTokens].sort()
  for (const theme of themes) {
    deepStrictEqual(Object.keys(themeVariables(theme)).sort(), expected)
    strictEqual(
      Object.values(themeVariables(theme)).every((value) =>
        typeof value === 'string' && value.length > 0
      ),
      true,
    )
  }
  strictEqual(new Set(themes.map((theme) => theme.id)).size, themes.length)
})

Deno.test('module theme uses semantic tokens, inherits a complete base and preserves built-ins', () => {
  const original = structuredClone(themes)
  const available = resolveThemeCatalog({
    schemaVersion: 1,
    themes: [{
      moduleId: 'test.theme',
      id: 'test.theme.round',
      label: 'Round',
      theme: {
        schemaVersion: 1,
        base: 'daylight',
        colors: { 'accent.default': '#ABCDEF', 'syntax.keyword': '#123abc' },
        shape: { 'radius.tab': [8, 8, 0, 0] },
      },
    }],
  })
  const external = getTheme('test.theme.round', available)
  strictEqual(external.colors['--accent'], '#ABCDEF')
  strictEqual(external.colors['--syntax-keyword'], '#123abc')
  strictEqual(
    external.colors['--syntax-comment'],
    getTheme('daylight').colors['--syntax-comment'],
  )
  strictEqual(external.colors['--bg'], getTheme('daylight').colors['--bg'])
  strictEqual(external.colorScheme, 'light')
  strictEqual(external.shape['--radius-tab'], '8px 8px 0px 0px')
  deepStrictEqual(
    Object.keys(themeVariables(external)).sort(),
    Object.keys(themeVariables(themes[0])).sort(),
  )
  deepStrictEqual(themes, original)
  strictEqual(
    getTheme(external.id, resolveThemeCatalog({ schemaVersion: 1, themes: [] }))
      .id,
    'graphite',
  )
  throws(() =>
    resolveThemeCatalog({
      schemaVersion: 1,
      themes: [{
        moduleId: 'test.theme',
        id: 'graphite',
        label: 'Hijack',
        theme: { schemaVersion: 1, base: 'graphite' },
      }],
    })
  )
})

Deno.test('external selection survives restart while awaiting the host catalog', () => {
  let raw: string | null = null
  const storage = {
    getItem: () => raw,
    setItem: (_key: string, value: string) => {
      raw = value
    },
  }
  strictEqual(saveThemePreference(storage, 'test.theme.round'), true)
  strictEqual(loadThemePreference(storage), 'test.theme.round')
  strictEqual(getTheme(loadThemePreference(storage)).id, 'graphite')
})

Deno.test('font roles quote family names, retain generic fallbacks and leave unspecified roles intact', () => {
  const original = structuredClone(themes)
  const available = resolveThemeCatalog({
    schemaVersion: 1,
    themes: [{
      moduleId: 'test.fonts',
      id: 'test.fonts.custom',
      label: 'Custom fonts',
      theme: {
        schemaVersion: 1,
        base: 'graphite',
        fonts: {
          'font.ui': ['Noto Sans', 'system-ui'],
          'font.code': ['JetBrains Mono', '가나다 글꼴'],
          'font.heading': ['Noto Serif'],
        },
      },
    }],
  })
  const custom = getTheme('test.fonts.custom', available)
  strictEqual(
    custom.fonts['--font-ui'],
    '"Noto Sans", system-ui, ' + themes[0].fonts['--font-ui'],
  )
  strictEqual(
    custom.fonts['--font-code'],
    '"JetBrains Mono", "가나다 글꼴", ' + themes[0].fonts['--font-code'],
  )
  strictEqual(custom.fonts['--font-note'], themes[0].fonts['--font-note'])
  for (
    const key of [
      '--font-heading',
      '--font-display',
      '--font-subheading',
    ] as const
  ) {
    strictEqual(custom.fonts[key], '"Noto Serif", ' + themes[0].fonts[key])
  }
  deepStrictEqual(themes, original)
  deepStrictEqual(getTheme('graphite', available).fonts, original[0].fonts)
  const legacy = getTheme(
    'test.fonts.legacy',
    resolveThemeCatalog({
      schemaVersion: 1,
      themes: [{
        moduleId: 'test.fonts',
        id: 'test.fonts.legacy',
        label: 'Legacy',
        theme: { schemaVersion: 1, base: 'graphite' },
      }],
    }),
  )
  deepStrictEqual(legacy.fonts, themes[0].fonts)
})
