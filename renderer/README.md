# Maghemite renderer

SolidJS workspace shell for code and notes. Vite is used for development and
bundling; the renderer runs in a browser/webview. It does not host a Node
backend.

## Run

To build and open the workspace through the Deno host, from the repository root:

```sh
deno task build
deno task desktop:dev modules-sdk/examples/theme
```

Open **http://127.0.0.1:8000/**. The host serves `renderer/dist` and the theme
catalog on the same origin. The root `build` task enables the catalog connection;
it builds the frontend assets, not a packaged native desktop executable. After
changing host code, stop the running host with Ctrl+C and restart it. Rebuild
after changing frontend code.

For frontend development with Vite hot reload, from this directory:

```sh
deno install
deno task dev --host 127.0.0.1
deno task build
deno task lint
deno task test
```

## Implemented shell

- Activity bar, primary sidebar, shared editor tabs, document context, optional
  bottom panel, and status bar.
- Develop / Knowledge perspectives keep document identity, open tabs, content,
  caret, and mounted view scroll position. The perspective changes navigation;
  it does not recreate the editor workspace.
- Explorer folders, code/note text editing, a safe limited Markdown preview,
  workspace text search, and a searchable keyboard command palette.
- Markdown outline and wiki-link backlinks derived from current note content. An
  SVG knowledge graph presents existing note-to-note wiki links.
- Resizable panels via pointer or arrow keys; narrow windows use sidebar
  overlays.
- Browser draft persistence, local text-file import, and download of edited
  files. Closing a tab retains its document draft in the workspace.
- Named appearance themes with separate color, corner and font tokens, persisted
  independently of workspace documents. No additional UI dependencies.

`Ctrl/Cmd+K` or `Ctrl/Cmd+P` opens the palette, `Ctrl/Cmd+S` saves a browser
draft, `Ctrl/Cmd+B` toggles the explorer, and `Ctrl/Cmd+J` toggles the bottom
panel. Editor tabs support Left/Right/Home/End. The palette supports
Up/Down/Enter/Escape.

## Ownership

| Area                           | Responsibility                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `src/workspace/model.ts`       | Shared code/note identities, view descriptors, session validation and note relationships |
| `src/workspace/store.ts`       | Workspace operations and the current browser-preview persistence adapter                 |
| `src/workspace/sample.ts`      | Explicit sample documents; not the local project filesystem                              |
| `src/workbench/`               | Explorer, tabs, document surfaces, context, graph, palette and tool panels               |
| `src/components/`              | Shared icons and accessible panel resize controls                                        |
| `src/themes/`                  | Typed appearance presets, preference persistence and root token application              |
| `src/App.tsx`                  | Workspace composition, perspective controls and global keyboard routing                  |
| `src/App.css`, `src/index.css` | Theme tokens, layout, density and responsive behavior                                    |

A view refers to a document ID rather than holding another content copy. Code
and notes can therefore share editing/lifecycle services while rendering
different surfaces. Knowledge graph is a separate view type using the same tab
container. Modules will register declarative contributions through the host;
they should not import Solid internals or own workspace state.

## Integrated terminal

The connected desktop host provides real interactive shells through **xterm.js +
deno-pty**, with **WebGL 2** rendering for the visible session. Open the bottom
panel's Terminal tab to start the first shell in the current workspace directory.
The `+` button creates another session; the close button terminates the selected
session. The host uses the configured login shell (`SHELL`, or `COMSPEC` on
Windows), falling back to the platform shell when that path is unavailable.

- **Ctrl/Cmd+backtick** focuses the terminal, or hides the panel when the terminal
  already has focus. **Ctrl/Cmd+Shift+backtick** creates a session.
- Terminal-focused keys such as Ctrl+C and Ctrl+D go to the shell. Use the
  workbench buttons to reach commands whose shortcuts the shell owns.
- Switching sessions, changing to Output, or hiding the panel preserves terminal
  buffers and alternate-screen applications. Theme colors and the code font
  follow the active application theme.
- WebGL activation failure or context loss falls back to the DOM renderer.
  Hidden sessions release their WebGL resources; output polling pauses when the
  terminal panel is hidden. Only the selected terminal is read by the UI.
- Each visited session retains 2,000 scrollback lines. The host journal retains
  at most 256 Ki UTF-16 code units per terminal; older unread output can be
  discarded, with an explicit message on return. Input is bounded and output
  parsing applies backpressure. This bounds buffering, not shell-process memory.
- Changing workspaces or closing the application terminates its sessions.
  Closing/hiding only the bottom panel does not terminate shells. Exited sessions
  display their exit status until closed.

The trusted workbench creates user shells through a dedicated host operation.
Modules still require terminal permission and a configured tool profile; they
cannot use the workbench operation to run an arbitrary shell. Packaged builds
include the deno-pty native library. Development hosts may select it with
`--pty-library=/absolute/path/libpty.so`; standalone Vite previews need a desktop
host connection before terminal operations become available.

## Themes

The approved workbench layout is shared by every theme. Panel placement, widths,
spacing, text sizes and document behavior are independent of appearance.

- **Graphite** (default): the original dark palette with square controls and
  tabs.
- **Soft charcoal**: lighter neutral charcoal surfaces and rounded controls,
  selected rows, tabs and dialogs.
- **Daylight**: the light palette with square components.

Choose a theme using the lower-left appearance button or the command palette's
`Choose color theme…` / `Theme: …` commands. The active theme is marked in the
chooser. Selection uses `maghemite.appearance.v1`, separate from document
drafts, and is applied before the Solid tree first renders. Unsupported/corrupt
settings fall back to Graphite. If browser storage is blocked, the current
session still changes appearance and reports that the preference could not be
saved.

`src/themes/registry.ts` owns `ThemeDefinition`: colors, shape and font tokens are
separate required records. Themes provide background/text/border/accent colors,
selection/scrollbar colors, warning/overlay/shadow colors, and semantic corner
radii plus separate UI/code/note/heading font roles. `App.css` and `index.css`
consume those variables; font stacks reside in the theme registry. Installed
fonts are tried in declared order with inherited fallbacks; no font downloads
are performed. Code and gutter fonts always match. Built-in font stacks, sizes
and line heights are unchanged. Circular status indicators retain a
semantic round radius. Brand artwork is independent of the theme palette.

`src/themes/apply.ts` applies tokens and the native control color scheme to the
document root. Selecting another theme does not recreate the workspace, its
documents, or editor elements. New presets should implement the typed appearance
contract rather than add layout-changing CSS overrides.

SDK theme contributions are supported through `src/themes/catalog.ts`. Public
semantic tokens are mapped to private CSS variables after validation, with
missing values inherited from a built-in base. Registered package themes appear
in the existing chooser and use namespaced IDs in saved preferences. A successful
catalog refresh that removes the selected theme falls back to Graphite; a failed
refresh retains the previous valid catalog. Startup renders a built-in fallback
until an external theme's catalog arrives.

For a connected Vite development preview, run `deno task desktop:dev modules-sdk/examples/theme`
from the repository root, then `deno task dev:themes --host 127.0.0.1` here and
open the URL printed by Vite. The built workspace itself opens on port 8000.
This opts into `VITE_THEME_CATALOG_URL=/api/themes`, proxied to the loopback Deno
host on port 8000. Choose **Charcoal dusk**, or use **Refresh module themes**
after restarting the host with changed packages. Normal `dev`/`build` remain
standalone when run inside `renderer/`; the repository-root `deno task build`
selects `build:desktop` and sets that variable automatically.
The theme engine depends only on validated data, not on the HTTP transport,
module guest runtimes or Solid component exports.

See [the theme SDK guide](../modules-sdk/themes/README.md). Local directory
registration is implemented; archive installation, marketplace/update UI and
automatic catalog watching remain future work.

## Current boundaries

This is a browser workspace preview with an optional read-only host theme
catalog. Other desktop services and the general host-renderer protocol remain
disconnected. Files on disk are never overwritten by this UI.
Browser drafts use the versioned `maghemite.workspace-preview.v1` localStorage
entry; they are specific to the browser and origin. Storage failures are shown
in the interface. Imported text files are limited to 256 KiB each, one million
bytes total at import, and 100 documents; edits are retained up to the preview
session size limit.

The source editor is a plain textarea for this shell stage, not a full language
editor. The Markdown preview supports headings, paragraphs, lists, quotes,
fenced code, bold/inline code and wiki links. It does not execute raw HTML or
remote links. Backlinks/graph currently understand wiki links only. These are
local document projections, not results from the native indexer.

The connected desktop terminal is implemented as described above. Standalone
previews display a disconnected terminal until a desktop host is available.
Output contains actual UI session messages.

Next integration boundaries: a CodeMirror/Monaco editor adapter, Deno document
open/save and workspace bindings, native index queries and SDK
command contributions. Split editor groups, drag-to-reorder tabs, complete
Markdown parsing, and a scalable graph renderer remain separate work.
