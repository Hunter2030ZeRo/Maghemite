# Application resource policy

Decision: 2026-09-26. Scope: the entire Maghemite application and all installed
modules. Requirements below distinguish present controls from planned work. WASM
is an isolation/portability choice, not a memory-efficiency guarantee.

## Measurement boundary

Measure a complete session: Deno Desktop/CEF browser, renderer and GPU
processes, Deno orchestration, native core, Wasmtime and Deno guests, compiler
workers, terminal sessions, debug targets, tool children and application-owned
caches. Separate user-launched project/build workloads from editor overhead, but
account for both and report their peaks. A worker-only echo test is not an IDE
benchmark.

Report these quantities separately:

- Download/package bytes, installed logical bytes, filesystem allocated bytes,
  shared dependencies, transient update space and persistent cache bytes.
- On Linux: process-tree RSS, PSS and private/unique resident memory where
  readable, plus guest linear memory and native runtime/compiler allocations.
  Summed RSS double-counts shared pages; large virtual reservations are not
  resident RAM.
- Platform-native counterparts on Windows/macOS with definitions and
  limitations. CPU/GPU/shared buffers need separate attribution; GPU VRAM is not
  process RSS.
- Cold/warm startup, time to usable editor and first language result, p50/p95
  input/provider latency, CPU time, peak memory and retained memory after idle.

Record hardware, OS, app/engine/tool versions, fixture size, cache state,
modules, permissions and measurement coverage. Do not present unavailable
metrics as zero. Compare VS Code/Zed only under the same workload and equivalent
language tools; no performance advantage is claimed before a controlled
comparison.

## Current implementation and gaps

| Area              | Present control                                                                     | Remaining requirement                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Wasm              | Per-linear-memory 128 MiB standard / 256 MiB compute; 16 memories; bounded instances/tables; fuel, deadlines   | Aggregate guest, worker and application budgets; compiler/native allocations are outside the linear-memory cap |
| Deno guests       | V8 old-space limit 128 MiB; denied ambient authority                                | Total process/tree accounting; old-space is not total RAM                                                      |
| Module lifetime   | Lazy activation; opt-in 60-second idle unloading; four task workers and queue of 32 | Stateful language-service eviction/checkpoint strategy, global pressure management and per-service telemetry   |
| Compilation       | Temporary compilation pool, up to 16 threads; private Wasmtime cache; two glibc arenas on Linux                | Global compilation concurrency/peak-memory control across module processes                                     |
| Compilation cache | 256 MiB soft limit, 1024 entries, compressed cache artifacts                        | Unified disk quotas; soft per-cache bounds do not guarantee app-wide limits                                    |
| Editors           | Lazy Monaco/CM6 loading, first-use mounting; inactive Monaco views released, models/undo retained                                         | Aggregate model/undo budgets and CM6 view retention; multi-platform stress measurements                              |
| Terminal          | Lazy xterm views; 2,000 scrollback lines/view; 256 Ki code-unit host journal/session; bounded input and output backpressure; hidden WebGL contexts released | Whole-process shell/build budgets and full application memory measurements |
| Indexing          | Bounded pipeline, one SQLite writer, incremental changes and file-size limits       | Measure query/page caches, parser duplication and index peaks alongside modules                                |
| Storage           | Indexed SQLite plus settings/recovery stores                                        | Selective Zstd payload compression and bounded restoration; no whole-DB compression claim                      |
| Distribution      | Separate installed assets, DEB/RPM/Arch and portable AppImage                       | Shared tool dependency storage, update-space budgets and complete language-package delivery                    |

The 128/256 MiB Wasm settings are PER MEMORY, with up to 16 memories; neither is a module RSS cap. Allocator/JIT/native state add further memory. The optional `wasmResources` manifest field selects a host-validated `standard` or
`compute` profile. Numeric or unlimited manifest budgets are not accepted.
Standard budgets remain 500M startup/50M call fuel; compute has 50B startup/10B
call fuel. Both retain the existing call deadlines and instance/table limits. No existing protections should be silently disabled to accommodate a large
language runtime.

## Required lifetime and storage policy

1. Install every advertised tool, then instantiate only services currently
   needed. Formatters/linters/debuggers must not all start at app launch. Keep
   one analysis state per appropriate workspace/tool version and share it
   between open views.
2. Admission control uses both per-service and app-wide budgets. Background
   tasks back off under pressure; compilation/indexing/debugger work cannot each
   assume the machine's full thread and memory capacity. Reserve headroom for
   typing.
3. Reclaim cold derived caches first, then idle workers and unused editor views.
   Preserve unsaved buffers, undo and recoverable session state before releasing
   owners. Avoid timeout/crash/restart loops when a project exceeds a budget.
4. Set runtime limits from representative measurements; choose soft/hard budgets
   for supported device classes. Do not invent a single fixed RAM promise before
   measuring real language services. Limits must include aggregate linear memory
   and host-owned allocations, with clear errors at the point of enforcement.
5. Zstd applies to immutable package blobs, cold snapshots and compressible
   cache payloads. Keep hot text/analysis structures directly usable. Use
   bounded/chunked decompression and version/checksum metadata; never restore an
   unbounded archive into memory. Decompression must not block the UI thread.
6. Keep the live SQLite database page-addressable and transactional. Compress
   suitable large values or offline snapshots, not the entire open database on
   every query. Indexed columns remain queryable. Respect WAL/checkpoint
   behavior.
7. Store immutable dependencies once by content and compatible version; count
   active users/versions for cleanup. Stream package staging and updates, bound
   temporary disk use, and retain only the required rollback versions.
8. Reuse compiled components where engine/CPU compatibility and isolation allow;
   compiled artifacts remain host-generated in private storage. Module-supplied
   native cache artifacts never become trusted merely because they are
   compressed.
9. WASI asynchronous I/O and CPU parallelism are separate concerns. Use bounded
   scheduling and incremental analysis; adding threads can increase peak memory.

## Whole-application scenarios and regression gate

Track the same fixtures on every supported platform:

- Empty window; Markdown/JSON editing with no language modules activated.
- Rust workspace: initial indexing/analysis, typing, completion, navigation,
  formatting, linting and a debug session; record first-install and warm-cache
  runs.
- Many tabs, code/note splits, large files, graph/backlinks, terminal output and
  workspace search under concurrent indexing.
- Ten open/close and enable/disable cycles; repeat workspace switches and retain
  dirty documents. Check for orphan processes and monotonically retained caches.
- Module update/removal, memory pressure, cancellation, slow disks and offline
  use.

Baseline raw data precedes optimization. A release gate must compare package
bytes, process-tree memory peaks/idle retention and latency distributions to the
same fixture baseline. Define explicit thresholds after representative repeated
runs, record approved regressions, and identify which process/cache grew.
Current CI does not yet enforce this whole-application gate.

## Disk inventory of the existing 0.1.0-2 Linux release

Measured from existing build outputs; no new release was built in this pass. The
raw inventory is
[2026-09-26-disk-inventory.json](docs/performance/2026-09-26-disk-inventory.json).
Values use MiB (1,048,576 bytes). These are overlapping views; do not sum them.

| View                                       |       Size |
| ------------------------------------------ | ---------: |
| DEB download                               | 163.54 MiB |
| Installed staging root, logical bytes      | 578.17 MiB |
| CEF `libcef.so`, inside that root          | 244.45 MiB |
| Guest Deno executable, inside that root    |  91.39 MiB |
| Desktop `Maghemite.so`, inside that root   |  78.56 MiB |
| Wasmtime host, inside that root            |  31.26 MiB |
| Rust core, inside that root                |  10.86 MiB |
| Renderer distribution, also included above |   5.86 MiB |

This identifies CEF and native runtimes as major disk contributors before a
complete Rust tool package is installed. It does not identify RAM usage.
Removing CEF assets or the guest Deno CLI without checking runtime requirements
would be incorrect; the latter has a different launch/security contract from the
compiled application. Evaluate supported runtime/build changes against
functionality and startup measurements, not file size alone.

The earlier [SDK performance report](modules-sdk/performance/README.md) measures
small guest workloads on Linux. It is useful historical evidence but explicitly
excludes full application responsiveness and real language analysis. Current
whole-application resident-memory baseline: **not yet measured**.

Compute modules yield every 100,000 fuel units (standard: 10,000). Total fuel,
memory, call deadlines and idle unloading are unchanged. The dedicated Linux
glibc WASM process limits allocator arenas to two before compilation and trims
free pages after joining compiler workers; this is not an RSS guarantee.
Workspace replacement releases revision and module-undo text references.

## Packaged WASI engines (2026-09-27)

JS/TS and C/C++ preview modules use explicitly declared WASI preview1 commands
inside the app's Wasmtime host, with a Deno SDK adapter. This path is separate
from the Component Model standard/compute profiles above; their fuel and memory
limits are unchanged. The new path caps each command at one 512 MiB linear
memory, one instance and two tables. Four commands may run across a host, with
at most two declarations per package and one live instance per declaration and
owner. This is not an aggregate RSS cap.

Compilation uses four temporary threads and the existing private compressed
cache. Pipes use 24 KiB chunks and OS backpressure. Active calls have the module
invocation timeout/cancellation; idle tools are killed after 60 seconds. The
preview1 path uses parent process deadlines rather than Component Model
per-call fuel; idle cleanup also bounds a guest running without a pending call.
A visible language document refreshes the lifecycle of already active tools.
Only package assets are mounted, read-only; no host tool discovery or workspace
mount is performed. Permission grants are explicit `wasm.execute` plus
`documents.read` for language snapshots.

Install staging remains bounded: 96 MiB for existing packages, 192 MiB for
packages declaring WASI tools, at most 4096 entries and depth 32. Tool binaries
are individually capped at 128 MiB and checked by SHA-256 at install and startup.
The larger budget accommodates LLVM and its portable standard headers. Actual
bundle sizes and engine timings are recorded separately; no whole-app memory or
performance superiority is implied by these limits.

## Runtime transport and integrity measurements (2026-09-27)

WASI package verification now hashes incrementally in 256 KiB chunks, retaining
per-registration/per-start checksum, ABI and path checks. Host and shared adapter
byte streams use Deno's native typed-array Base64 codecs. Component and preview1
compilation now share the joined temporary-worker implementation, including
cleanup after compilation errors. Numeric budgets are unchanged.

The [runtime optimization and gap report](docs/runtime-optimization-and-gaps-2026-09-27.md)
contains real TypeScript/OXC/LLVM before/after measurements and raw data. Host
verification VmHWM fell from about 135 to 48 MiB (JS/TS) and 191 to 49 MiB
(C/C++). Cold JIT startup and retained language-engine memory remain substantial;
whole-application memory and responsiveness have not been measured by this probe.
Use `deno task modules:runtime-perf --output=/absolute/report.json` on Linux.
