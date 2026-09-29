# Maghemite project structure

This document fixes the ownership boundaries. Some directories still reserve future implementation areas; the native filesystem index and its Deno bridge are implemented.

The first executable Modules SDK slice is also implemented; see
`modules-sdk/README.md` for its contract, runtime limits, tested toolchain, examples
and remaining API areas.

```text
Maghemite/
├── deno.json                 Deno Desktop application configuration
├── src/
│   ├── desktop/              Deno host, windows, renderer serving, bindings
│   ├── core/                 Deno workspace state, documents, commands, settings
│   │   └── workspace/        Workspace domain areas
│   ├── modules/
│   │   ├── host/             Installation, lifecycle, capabilities, contributions
│   │   ├── runtimes/wasm/    WebAssembly Component execution adapter
│   │   ├── runtimes/deno/    JavaScript and TypeScript execution adapter
│   │   └── compat/vscode/    VS Code API compatibility adapter
│   ├── native/               Typed Deno-to-Rust bridge and adapters
│   └── shared/protocol/      Versioned host-renderer data contracts
├── renderer/                 Solid UI; Vite is a development/build tool
├── modules-sdk/
│   ├── wit/                  Language-neutral Component Model contracts
│   ├── js/                   JavaScript/TypeScript SDK facade
│   └── tooling/              Validation, packaging, binding generation
└── native/                   Cargo workspace for Rust core and platform code
    ├── Cargo.toml
    └── crates/
        ├── core/src/          Indexing, search, graph, and intensive algorithms
        ├── pty/src/           Native terminal process and PTY integration
        └── wasm-host/src/     Native WebAssembly Component runtime
```

## Boundaries

- Deno Desktop owns the application lifecycle, workspace orchestration, module host, and native integrations. The Solid renderer displays state and calls typed host bindings through `src/shared/protocol`.
- Core is split by responsibility: `src/core` owns Deno domain services and state; `native/crates/core` owns performance-critical Rust algorithms such as indexing, search, and graph processing. The index and search directories live in that Rust crate. The Deno services call Rust through `src/native`, and neither core layer depends on the renderer or a module runtime. Module adapters call core services through host-controlled capabilities.
- Maghemite Modules SDK owns the public, versioned API. A Wasm guest must implement the required WIT world as a WebAssembly Component; compiling arbitrary source to a core `.wasm` file alone is insufficient.
- JavaScript and TypeScript modules use the Deno execution adapter. The `vscode.*` compatibility layer also uses this path and maps supported APIs to the common host services.
- UI contributions are declarative registrations consumed by the renderer. Modules do not depend on Solid component internals.
- Rust core code is a first-class part of Maghemite behind the Deno host bridge. The PTY and Wasm host crates are separate native integration areas. Rust host code is distinct from third-party Wasm modules.

## Module execution

- `src/modules/host` owns local module registration, manifest validation, command
  ownership, lazy activation, grants and lifecycle. Requests from both runtimes
  pass through the same capability broker. Public SDK version 0.1.0 is independent
  from WASI version 0.3.0.
- Deno modules run in restricted child Deno processes. Wasm modules run in the
  `maghemite-wasm-host` Rust worker executable, using Wasmtime with Cranelift JIT,
  native Component Model async, and WASI 0.3 imports. WASI 0.2 imports serve guests
  whose standard libraries still use that version. Rust/Python use the native
  async SDK world. New C/C++/C# projects also use it; existing synchronous
  projects retain the explicit `maghemite:modules-sync@0.1.0`
  compatibility world. The manifest selects its ABI without implicit fallback.
  Both worlds share the capability broker; sync guests do not gain native async
  semantics. The CLI uses a release host with bounded temporary Cranelift workers and a
  private Wasmtime compilation cache. Content and engine compatibility determine
  cache validity; packages never supply trusted native artifacts.
- Async task services provide bounded host timers and permission-gated worker
  commands in fresh isolated instances. A host-wide pool defaults to four
  workers and 32 queued jobs; nested workers are denied and cancellation owns
  the entire child lifetime. See `modules-sdk/TASKS.md`.
- Process transport is bounded and asynchronous. Progress awaits acknowledgement
  from the host; activation and execution return promises. One call runs per
  module at a time, while different modules can run concurrently. A deadline or
  cancellation terminates that module process. Graceful deactivation releases
  guest cleanup hooks; disabling/unregistering removes command availability.
  Modules explicitly declaring `lifecycle.idleUnload` may be deactivated after
  60 seconds of inactivity and reactivated on demand; stateful/background modules
  remain resident by default. Commands arriving during idle cleanup wait safely.
- `modules-sdk/wit` is the language-neutral contract, `modules-sdk/js` is the
  JavaScript/TypeScript facade, and `modules-sdk/rust` generates native async guest
  bindings. `modules-sdk/tooling` creates self-contained TS, JS, Rust, Python, C,
  C++ and C# projects and builds them through pinned language toolchain recipes.
  The Rust example also calls an actual WASI 0.3 asynchronous timer. C# uses a
  prerelease NativeAOT toolchain; its current recipe supports Linux x64 builds.
- Desktop palette, document/knowledge/UI APIs and native filesystem, index,
  settings, PTY and tool services are connected through a capability-checked,
  authenticated single-workbench adapter (`modules-sdk/APP_API.md`). Persistent local package installation, opt-in permissions and updates are managed
  by the desktop Modules sidebar. The HTTP host serves the renderer and theme
  catalog; Deno Desktop/CEF creates the native window; Linux ships DEB, RPM,
  Arch packages and an optional AppImage.
  VS Code/Obsidian compatibility layers and marketplace services remain separate work.

## Portable language packages and resource requirements

Language support is delivered as a complete, application-managed tool package:
analysis/LSP, debugging/DAP, linting, formatting and dependencies. The intended
execution is portable WASM with versioned SDK capabilities; users must not need
to install language tools separately or repair PATH. Runtime selection must be
explicit. The package/provider implementation is still pending.

See [the language package contract](modules-sdk/LANGUAGE_PACKAGES.md), which
supersedes the earlier external-server roadmap, and [the application resource
policy](RESOURCE_POLICY.md). Full tool availability at installation and lazy
service activation are both required. Whole-app accounting includes CEF, Deno,
native core, guest workers, JIT and data caches; a guest memory limit does not
represent an application memory limit. Existing process-profile APIs remain
compatibility/explicit integration mechanisms, not the default language package.

## Native filesystem index

- `native/crates/core` builds a `cdylib` with ABI version 1. The exported C functions register and close workspaces, start full or path-specific index jobs, report progress and errors, cancel and release jobs, and shut down worker threads before unloading.
- `src/native/core.ts` is the typed Deno FFI adapter. Callers pass the shared-library path to `CoreBridge.open`; the Deno process needs FFI permission. The Rust `Result` values are translated to stable integer status codes at the C boundary.
- `src/core/workspace/filesystem/indexer.ts` chooses a per-user index database outside the workspace, starts the first scan, and uses `Deno.watchFs` to coalesce OS events into path-specific refresh jobs. An event that cannot be localized schedules a full scan.
- The index job thread walks the filesystem and sends paths through a bounded queue. Scoped Rayon workers read and hash eligible files, extract Markdown headings/links and Tree-sitter source symbols, then send results through another bounded queue. One SQLite writer owns the connection and transaction. It commits only after traversal and workers finish successfully; cancellation or any stage failure rolls back the scan. Rayon threads finish before the native library can be unloaded.
- SQLite stores relative path bytes, file kind, size, modification time, BLAKE3 hash, extracted symbols/links, and scan generation. A successful scan removes entries no longer present. Symlinked directories are recorded but not followed. Files over 64 MiB and files in `.git`, `node_modules`, `target`, or `.venv` retain metadata but skip content hashing; parsing is limited to supported text files of 2 MiB or less. The paginated index.query API supplies workspace knowledge views. Semantic language-server integration remains separate work.

## Source symbol parsing

- `native/crates/core/src/index/text/source.rs` owns native Tree-sitter parsing. Rust, TypeScript/TSX, JavaScript/JSX, Python, and Go use their own bundled grammars. `.mts`, `.cts`, `.mjs`, `.cjs`, and `.pyi` also map to the corresponding grammar. Language-specific symbol queries live in `index/text/queries`; TypeScript extends the shared JavaScript query.
- Each Rayon consumer owns and reuses its parser and query cursor. Queries are compiled on first use for each language and shared immutably within a job. Parsing and query execution observe job cancellation; parser errors propagate to the writer so the transaction rolls back. Recoverable source syntax errors still allow extraction from intact declarations. No parser, query cache, or worker thread persists beyond the job's lifetime.
- Queries extract named functions/methods, classes/types, fields, constants and supported variable binding patterns. Comments, string contents, type annotations, property keys in destructuring, and initializer references are excluded. These are syntactic declarations: assignments in Python and short declarations in Go do not yet resolve which bindings are new. Macro expansion, import/export alias resolution, type inference, references and cross-file definition resolution require a semantic provider such as an LSP server. Markdown/MDX continues to use the existing heading/link parser in `index/text/markdown.rs`; MDX embedded code is not analyzed.
- SQLite symbols include language, kind, the name's selection range, the declaration's byte range, and a named container path such as `engine::Index::build`. Lines are one-based; columns and offsets count UTF-8 bytes from zero, with exclusive ends. Consumers must convert columns if they require UTF-16/LSP positions. The primary key includes the column so identical names in separate scopes on the same line remain distinct. Legacy and Markdown rows have no source range.
- Analysis version 2 triggers symbol replacement on the next successful scan even when file content hashes have not changed. Opening an old database migrates the symbol schema transactionally and preserves its rows until rescanned. File refresh currently reparses the whole eligible file; syntax trees are released after extraction rather than stored in SQLite. Extraction is capped at 4,096 symbols per file, in addition to the existing 2 MiB parse limit.

## Renderer workspace shell

- `renderer/src/workspace` owns a shared document model for code and notes, view
  references, layout state and an explicit browser-preview persistence adapter.
  `renderer/src/workbench` composes the primary sidebar, editor tabs/surfaces,
  secondary context, graph, palette and bottom panel. The renderer uses Solid.
- Develop and Knowledge change the navigation perspective while retaining open
  views and document state. Graph is a view type in the same tab container.
- Standalone preview uses sample documents and imported text copies. With a
  desktop folder selection (or `--workspace`), Explorer lists real directories lazily, opens disk files,
  and creates files/folders through the Rust core. Disk saves use version-checked
  staged writes; unbound workspace drafts create new files without overwriting an
  existing path. PTY, diagnostics and declarative module views are connected.
- Recovery sessions use a SHA-256 identity of the canonical workspace root.
  Browser recovery snapshots retain the disk BLAKE3 version and unsaved text;
  disconnect never turns a disk save into a browser-only successful save.
  The host reconnects automatically and checks disk bindings against current
  versions. External-change conflicts offer explicit reload or draft download.
  Reload checks the editor version again after reading, preserving concurrent
  edits. Host recovery snapshots are persisted independently of the browser origin.
  Incremental crash journals remain subsequent work.
- Note outline uses live document content. Backlinks and graph combine the native
  index (including unopened notes) with unsaved document overlays. Code outline
  reads indexed symbols for saved documents. Modules continue to contribute
  through declarative host contracts, not Solid internals.

- `renderer/src/themes` owns appearance presets. The application Settings tab
  owns theme selection and optional user/workspace font overrides; the old
  browser theme preference is imported for standalone previews. Theme colors, corner radii and UI/code/note/heading font families
  are applied as root CSS variables. Panel layout, font sizes, line heights,
  dimensions and document state remain independent. Built-in themes preserve
  the approved font stacks. Font roles use installed names with base fallbacks;
  external font-file loading is a separate future contribution.
  Graphite is the default dark/angular preset, Soft charcoal provides lighter
  dark/rounded surfaces, and Daylight retains light appearance.
- `modules-sdk/themes` defines a versioned, runtime-neutral declarative theme
  contract. `contributions.themes` may stand alone without runtime/entry/capabilities,
  or accompany commands in a Deno/Wasm package. Host registration validates and
  reads package-contained JSON atomically; theme loading never starts guest code.
- `ModuleHost.themes()` publishes static contributions independently of guest
  failure/idle unloading. Package disable/unregister withdraws them. The optional
  read-only desktop `/api/themes` endpoint transports this snapshot; the renderer
  maps semantic SDK tokens to its private CSS variables and existing chooser.
  Standalone browser preview remains available without a host connection.
- The repository-root `deno task build` builds `renderer/dist` with the theme
  catalog connection enabled. `desktop:dev` serves this UI at the loopback root
  URL alongside `/api/themes`; it never serves repository sources. Missing builds
  return an actionable 503 response. `desktop:window` wraps the host in CEF;
  `desktop:package` bundles the renderer and native sidecars for distribution.
- Missing selected themes fall back to Graphite on an authoritative refresh.
  Failed refreshes retain the last valid catalog. External theme startup caching,
  package source watchers and marketplace updates are future work. Local
  installation and explicit updates are available in the Modules sidebar.

## Extension growth plan

The accepted workbench shell remains the common surface. Language support,
tool integrations and convenience features should arrive through Modules SDK
contributions and host services. See `modules-sdk/EXTENSIONS.md` for planned
boundaries and implementation order. Initial application APIs are documented in
`modules-sdk/APP_API.md`. Six versioned document-scoped language features now reach
Monaco through module commands; project-wide orchestration remains subsequent work.
Monaco and CM6 are connected through the shared editor adapter.

## Built-in features and module ownership

- Application/workspace settings, safe document storage and recovery, workspace
  navigation, Markdown and JSON are built-in product responsibilities.
- Git/source control is supplied by a module. Debugging integrations are supplied
  by language/tool modules. Core provides permission-checked process, protocol,
  document and declarative UI services for these contributions. Git commands,
  providers and debugger-specific controls are not mandatory built-in features.
- Monaco handles code and JSON, CodeMirror 6 handles Markdown. Both adapters use
  the same UTF-16 document, selection, diagnostics, external-edit and undo boundary.
  The accepted workspace layout is retained. Project-aware language providers and
  broader language actions are the next milestones; Git and debugging remain module responsibilities.

## Application preferences and current workspace workflow

- Open Settings using the activity-bar control, command palette or Ctrl/Cmd+,.
  User values apply to every desktop workspace; project values override individual
  fields. Reset removes that scope's override. Themes, UI/code/reading fonts,
  editor sizes/indentation/wrapping/gutter, initial note view, autosave and close
  confirmation apply immediately. The default theme remains Graphite.
- `src/shared/preferences.ts` is the shared schema and validation boundary.
  `src/desktop/preferences.ts` stores validated preferences under the host data
  directory's `preferences/` namespace, separate from module settings. Writes
  use optimistic versions and atomic replacement; stale concurrent writes fail.
  Project preferences are keyed by canonical workspace identity, not by port.
  Desktop disconnection makes settings read-only until reconnection.
- `renderer/src/workspace/preferences.ts` resolves defaults, user values and
  workspace overrides. Browser preview preferences remain local to that preview;
  connecting to the desktop loads the host's own persisted preferences.
- Open a disk root from **Open folder**, the command palette, or **Ctrl+Shift+O**.
  The dialog provides a system folder picker, direct absolute path input (including
  `~/`), and up to ten recent folders. `src/desktop/workspaces.ts` stores canonical
  roots in private `workspaces.json`; launch reopens the last available root unless
  `--workspace=/absolute/project/path` overrides it. An unavailable last root opens
  the sample workspace. Explorer loads directory pages on demand.
- Folder changes stage and validate a new workspace on the existing Rust bridge,
  stop module runtimes and tools, checkpoint drafts, then swap watchers and index
  handles. The bridge lives until application shutdown because its shutdown is
  process-global. Installed modules, grants and disabled states survive; enabled
  runtimes activate afresh on demand. The authenticated renderer reconnects and
  restores the selected folder's tabs, drafts and preferences. Failed validation or
  recovery keeps the current root. A busy modal prevents editing during transition.
- Folder selection is a trusted workbench operation, not a module SDK capability.
  Linux uses KDialog/Zenity; macOS/Windows chooser adapters are implemented but not
  validated on those platforms. A path field works without an external picker.
  Refresh and window focus check open disk versions.
- Host recovery stores complete, bounded snapshots under `recovery/<workspace-id>.json`.
  Browser caches retain edits while offline and during the debounce window.
  Snapshots survive browser/port changes and preserve disk versions. Current
  editor/document and transfer size limits remain in force. This is snapshot
  recovery, not a per-keystroke write-ahead journal or a backup system.
- `deno task workspace:test` covers preference inheritance/persistence, invalid
  settings, concurrent updates, workspace confinement, stale disk bindings and
  reload races. Existing native-service and workbench tests cover lower layers.


## Editors, host recovery and local module management

- `renderer/src/editors/protocol.ts` defines the engine-neutral adapter. Engines
  load lazily; JSON workers run separately. Only JSON language intelligence and
  Markdown are bundled as product languages. Other files remain plain text until
  an appropriate provider is integrated; language labels alone do not implement
  completion, rename, formatting or semantic diagnostics.
- Engine-originated edits update the shared document store. External SDK edits
  use minimal replacements so normal engine undo histories survive. Reactive
  updates are deferred until each engine finishes its current transaction.
  A shared text mapping preserves CRLF and UTF-16 source positions while engines
  normalize their internal line breaks. Theme/font settings apply to both
  engines, including editors in inactive tabs.
- `src/shared/workspace.ts` holds validated session data and canonical note-link
  resolution. Relative paths, root paths and unique wiki names resolve; ambiguous
  names and external URLs do not become graph edges. The live Markdown link
  scanner and reading preview are intentionally small subsets of CommonMark.
- `src/desktop/recovery.ts` accepts sequential 4,096-character chunks, validates
  complete sessions, compares revisions, syncs a private temporary file and
  atomically replaces the snapshot. Transfers expire and disconnect clears them.
  One desktop host owns each data profile via an OS file lock. Browser/host
  conflicts ask which snapshot to restore while retaining the alternative copy.
  Recovery snapshots are currently JSON; Zstd remains applied to the Wasmtime
  cache, not the live SQLite database or these small recovery records.
- `src/desktop/module_manager.ts` copies reviewed packages into private slots,
  rejects symlinks, bounds package size/count, and atomically records installation
  metadata. Review never runs guest code. Updates retain only previously granted
  capabilities still declared by the new manifest; new permissions default off.
  Permission changes stop the old runtime and release its resources before
  registering a new instance. Removal retains module storage/settings.
  CLI-registered packages remain visibly managed by launch options.
- Knowledge views use revision-consistent index pages with a 10,000-record limit
  for each of files and links, and retain the last snapshot offline. The diagram
  shows at most 200 notes; SDK graph output is bounded separately. The current
  code outline shows up to 20 symbols, and hides stale symbols while a code buffer
  has unsaved edits. Larger datasets need a virtualized/spatial graph view.

## Native window and packaging

Development browser host:

```sh
deno task build
deno task desktop:dev --workspace=/absolute/project --port=0
```

Native CEF window (installed Deno must support `deno desktop`):

```sh
deno task desktop:window --workspace=/absolute/project
```

Build on the target OS/architecture with its Rust toolchain and the deno-pty-ffi
0.42.0 shared library. `desktop:prepare-pty` prepares the PTY dependency; pass the
resulting native library path explicitly to packaging:

```sh
# Linux default: DEB, RPM and Arch packages in build/packages/
deno task desktop:package --pty-library=/absolute/path/to/pty-library

# Select formats; AppImage remains available as the portable option.
deno task desktop:package --pty-library=/absolute/path/to/pty-library --formats=deb,rpm,arch,appimage
```

- `package.ts` builds the Rust core/Wasmtime host and renderer, and stages the
  matching Deno CLI, guest worker/SDK sources and PTY library once.
- Installed Linux packages use `installed.ts`: native assets remain physical files
  under `/usr/lib/maghemite/assets`, resolved relative to the real executable.
  They are neither embedded again nor extracted into each user's profile. The
  package manager owns those resources, while settings/modules/index/recovery
  remain in the user's application data directory.
- Portable builds use `packaged.ts`: embedded assets are verified and materialized
  into a private, content-addressed runtime directory, since embedded files cannot
  be executed or loaded by FFI directly.
- `/usr/bin/maghemite` and the application menu entry are owned by the package.
  Removal does not delete user data. File/MIME handlers are not registered until
  file-open arguments and delivery to an existing window are implemented.
- The compiled desktop executable is never used as the guest Deno CLI. Guest
  processes keep explicit deny permissions and use only brokered application APIs.
- Native windows use an OS-selected loopback port. The same origin/token checks
  protect the workbench socket. Linux CEF argument suffix duplication is normalized
  before parsing workspace and data-directory options.
- The Linux packagers use native distribution tools in disposable Docker containers
  and disable stripping of Deno's appended payload. Their metadata declares the
  actual ABI floor (glibc 2.39, libstdc++ from GCC 12); the build rejects newer symbol
  requirements. This is driven by the currently supplied PTY/backend binaries.
- See [Linux packaging](packaging/linux/README.md) for prerequisites, artifact
  locations, installation, verification, and remaining public-release work.
- Windows/macOS distribution, signing,
  and update delivery remain outside this Linux packaging milestone.
