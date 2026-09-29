# Maghemite workbench design

## 1. Identity

Preserve the existing Develop / Knowledge workbench. New capabilities belong
inside its sidebar, document area, inspector, palette and bottom panel, not in
a redesigned shell. Graphite remains the default; every surface also supports
Soft charcoal and Daylight.

## 2. Color

`renderer/src/themes/registry.ts` owns the complete theme palettes.
Use `--bg`, `--sidebar`, `--rail`, `--top`, and `--surface` for surfaces;
`--text`, `--bright`, `--muted`, and `--faint` for content;
`--line` and `--subtle-line` for separators; `--hover` and `--selected`
for interaction states. Warnings use `--warning-bg` / `--warning-text`.
Selection and focus use the existing `--selection` / `--accent` tokens.
Do not hardcode new theme colors in feature components.

## 3. Typography

Keep the existing font roles: `--font-ui`, `--font-code`, `--font-note`,
and `--font-heading`. Preferences can override them. The existing dense
workbench uses 10 px metadata, 11 px controls, 12 px secondary text and
13 px base text; editor and note sizes follow user preferences.
Paths, code and replacement previews use the code font. Long paths wrap or
truncate with a title exposing the full value.

## 4. Layout

The viewport shell owns height; `.sidebar-body` owns sidebar scrolling.
Document surfaces and the bottom panel own their own scrolling. Keep
`min-width: 0` / `min-height: 0` on flexible panes.
Retain the existing 1050 px compact-sidebar transition and overlay behavior.
New compact forms use the neighboring 4, 8, 12 and 16 px spacing steps.
Editor groups share the document area and must remain usable at narrow widths.

## 5. Components

- `Icon` / `IconButton`: existing SVG icons, accessible names, hover surface,
  focus ring and disabled state. Never substitute emoji.
- `.search-field`: labeled input inside the existing bordered surface.
  Forms provide explicit submit/cancel actions, visible pending state and
  inline error text. Filters wrap rather than widening the sidebar.
- `.search-result`: path, position and contextual text; a separate checkbox
  selects replacements without nesting interactive controls.
- `.text-button` / `.primary-button`: reuse existing sizes and color roles.
  Disable destructive actions while a request is pending or a preview is stale.
- `.new-path-form`: inline file operation form with cancel and error states.
- `ResizeHandle`: existing pointer and keyboard resize affordance.

## 6. Interaction

Keep current focus and keyboard behavior. New operations acknowledge pending
state immediately, retain user input on failure, and cancel owned work on
unmount or workspace change. No decorative animation is required.
Search replacement always follows a visible preview and explicit selection.
Dirty documents must never be silently overwritten by disk operations.

## 7. Surface

Use the existing tonal surfaces and one-pixel separators. Corners use the
theme's `--radius-*` tokens. Shadows are reserved for the existing dialogs and
drawers; feature forms and result lists stay within their parent surface.

## 8. Accessibility and verification

Label every input and icon action. Use native buttons, checkboxes and forms;
announce asynchronous status and errors. Preserve visible keyboard focus.
Check new surfaces with empty results, long and Korean paths, errors, pending
operations, and desktop/narrow viewport widths. The existing compact type
scale is preserved, not a claim that all existing accessibility issues have
been audited. No new accessibility debt is accepted.
