# Trusted process lifecycle

Maghemite exposes one configured-process surface for modules that need Git,
test runners, formatters, linters, language servers, or debug adapters. Git and
language-specific behavior stays in modules. The trusted host only starts
administrator-configured profiles and owns their lifecycle.

## Authority boundary

- Modules cannot submit a command, executable path, or argument vector.
- `tools.start`, `terminal.create`, `language.start`, and `debug.start` accept a
  configured profile ID. Profile kind must match the API.
- Starting any process requires the profile API capability plus
  `process.execute`. Reading, cancelling, and collecting a result remain scoped
  to the unforgeable runtime owner that started the session.
- Resource admission is host-only. It is not an SDK capability and cannot be
  configured by a module.

## Tool execution contract

`tools.start({ profile, input? })` returns an owned session. The host closes
stdin after writing the bounded input. Output can be consumed in either form:

1. `tools.read({ session, cursor? })` pages retained stdout while the process is
   running. `done` and `exitCode` report observed process completion.
   `dropped` covers stdout before the requested cursor;
   `stderrTruncated` covers stderr loss.
2. `tools.result({ session })` waits for process completion without polling,
   returns the final bounded result, and releases the session handle.

Every tool exit emits `tools.output`, even when the process wrote no output.
Subscribers can therefore wait on that event and then call `tools.read` or
`tools.result`.

The final result contains:

- `stdout`, `stderr`, and `exitCode`;
- `cancelled`, which is true when host cancellation was requested before a
  natural exit;
- `complete`, which is true only when both retained streams are complete; and
- `truncated.stdout` / `truncated.stderr`, which identify bounded-journal loss.

`tools.cancel({ session })` kills the owned process but retains the handle so its
result can be collected. Existing `tools.stop({ session })` remains the
cancel-and-discard operation for compatibility. An aborted `tools.result`
request also cancels its owned process.

Formatter and linter convenience calls still return only complete results. They
reject explicitly if either output stream exceeded its journal instead of
silently returning partial text.

## Terminal and protocol completion

Terminal reads expose `done` and `exitCode`, and terminal exit emits a final
`terminal.output` event even when no final text was produced. LSP and DAP reads
expose `closed` and `exitCode`; a quiet protocol-process exit emits the matching
`language.message` or `debug.message` event. Explicit stop, owner release,
workspace replacement, and application close wait for teardown.

Protocol request cancellation is request-scoped. LSP requests additionally send
`$/cancelRequest`; DAP has no universal cancellation command, so adapter-specific
cancellation remains a module responsibility.

## Shared resource admission

Native services and `ModuleHost` default to the same application
`ResourceAdmission`. Tests and embedders may inject that controller through
`NativeOptions.resources`.

Before a terminal, tool, formatter, linter, LSP, or DAP process is spawned, the
host reserves **512 MiB** from the shared application budget. This is a
conservative scheduling unit for an executable plus possible descendants, not a
hard RSS limit and not a claim that the process consumes 512 MiB. The controller
continues to use observed owned-process-tree RSS when available and charges the
larger of observed RSS and reservation.

For `Deno.Command` children, the host reports the known PID immediately after
spawn so tree RSS and the reservation share one accounting bucket. The PTY
library does not expose its child PID, so terminal RSS remains `null` and its
reservation stays unattributed. Missing measurements are never reported as
zero.

Admission is FIFO, bounded, and abortable. Session limits and
closing/releasing/aborted state are checked both before and after admission.
Reservations are returned after natural exit, startup failure, cancellation,
explicit close, owner release, workspace replacement, or application close.

## Remaining limits

- Output journals are bounded host memory, not complete process logs.
- Cancellation uses forceful process teardown; it is not a graceful,
  tool-specific shutdown protocol.
- Descendants that detach or reparent can escape ancestry-based telemetry.
- The 512 MiB reservation is a conservative initial policy pending measured
  workload-specific terminal, Git, test-runner, LSP, and DAP profiles.
- The host does not implement Git operations, test semantics, debugger
  semantics, or language intelligence. Modules build those behaviors on the
  configured lifecycle APIs.
