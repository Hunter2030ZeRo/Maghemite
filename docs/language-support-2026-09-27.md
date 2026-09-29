# JavaScript/TypeScript and C/C++ module delivery

Date: 2026-09-27. Both modules are 0.1.0-alpha.1. Desktop package: 0.1.0-9.

| Module | Engines | Install directory |
| --- | --- | --- |
| JavaScript / TypeScript | TypeScript 7.0.2, Oxlint 1.85.0, Oxfmt 0.70.0 | `build/modules/javascript` |
| C / C++ | LLVM 23.1.2 clangd with clang-tidy and clang-format; bundled C/libc++ headers | `build/modules/cpp` |

The adapter runtime is declared as Deno. All language analysis engines are bundled WASM commands run by the application's Wasmtime. Runtime tool discovery, Node/npm, host clangd and native language-tool fallbacks are not used. The new SDK facility is general-purpose; it is not limited to language modules.

## Verified features

- Actual engine hover, completion, same-document definitions, diagnostics, semantic/syntax highlighting and formatting.
- TypeScript type errors combined with real Oxlint warnings, Oxlint suppression comments, Oxfmt idempotence, JS typing and TSX formatting.
- C++ vector-header completion and inference, C stdio headers, compiler errors, clang-tidy nullptr suggestions, clang-format idempotence.
- Unsaved source revisions, Unicode/CRLF positions, rejection of split UTF-16 positions, owner isolation, bounded byte streams, cancellation, capability discovery and package integrity.
- Both distribution directories installed into a temporary profile, executed from immutable installed copies, and removed. The user's installed modules and grants were not modified.
- Final portable-engine suite: 5 tests passed. Existing application broker/language protocol suites: 9 passed. Module-manager suite: 2 passed. Existing Python suite: 2 passed. Distribution install/remove test: 1 passed. Renderer production build and Deno checks passed. Arch desktop package built successfully.

Raw artifact sizes and SHA-256 are recorded in `language-support-2026-09-27.json`. These are package logical bytes, not memory measurements or application performance claims. JS/TS payload: about 57.85 MiB; C/C++ payload: about 93.59 MiB. Build sources and caches are excluded from install payloads.

## Activation

Install `build/packages/maghemite-0.1.0-9-x86_64.pkg.tar.zst`, restart Maghemite, then install the two directories above through Modules. Opt in to `documents.read` and `wasm.execute` to enable language features. The source directories contain development files and should not be selected for installation.

## Current scope

Document preview, up to 128 KiB. Project-wide imports/headers, tsconfig, compile_commands.json, cross-file navigation, auto-import edits, project compilation and debugging are not implemented. C/C++ is analyzed for the bundled wasm32-wasip1 target; host-specific platform headers/ABI are not inferred. TS7 uses cooperative Go goroutines on one guest thread. clangd runs synchronously with filesystem compilation-database watching and background indexing disabled. Native-thread performance is not claimed.

## Main implementation

- `modules/javascript`, `modules/cpp`: manifests, real WASM engines, source pins/patches, portable assets, build/package scripts and integration tests.
- `modules/language-common`: reusable LSP framing, snapshot/UTF-16 conversion, completion selection, diagnostics/formatting/token adapter and staging helpers.
- `modules-sdk/js/app.ts`, `modules-sdk/WASI_TOOLS.md`: typed general-purpose WASI tool API and its generic app-request equivalent for other SDK languages.
- `src/modules/host/wasm_tools.ts`, `manifest.ts`, `host.ts`: fixed package tools, checksum validation, capability/owner enforcement and cleanup.
- `native/crates/wasm-host/src/wasi_tool.rs`: bounded WASI preview1 host and explicitly declared cooperative stdin extension. Existing Component Model execution remains available.
- `src/desktop/module_manager.ts`, `renderer/src/workbench/ModuleManager.tsx`: bounded larger/header-rich packages and required-permission messaging.

Rebuild tasks: `javascript:build`, `javascript:package`, `javascript:test`, `cpp:build`, `cpp:package`, `cpp:test`. Build-time native toolchains are distinct from runtime dependencies. See module READMEs and `RESOURCE_POLICY.md` for the exact limits.
