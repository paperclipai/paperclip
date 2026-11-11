# Native harness SDK

`@paperclipai/runner-sdk` is the small public boundary for an independently
installed npm package to provide a native Paperclip harness. It has **no runtime,
optional, or peer dependencies**. Installing Paperclip does not install a harness
that merely uses this SDK.

The package root and `./contracts` export browser-safe declarations, JSON data
types, immutable release identities, and strict protocol parsers. `./host` exports
the Node stdio host. Provider clients and native executables belong to the external
harness package. They must never become SDK dependencies.

## Package declaration

A plugin contributes a `runnerHarnesses` declaration describing its `harnessKey`,
display name, JSON configuration schema, platform targets, boolean capability
claims, prebuilt runtime entrypoint and SHA-256, and optional credential keys.
Runtime entrypoints stay inside the installed package. Credentials name only
declared secret inputs; process-control environment variables are rejected.

The installer binds a namespaced harness ID (`plugin.id/harness-key`), exact npm
package name/version/integrity, harness protocol version and complete runtime
digest into a `RunnerHarnessReleaseIdentity`. This identity is admitted by the
controller and independently verified by Runner before process launch. A harness
does not authorize installation or choose a different runtime by returning metadata.

## Process host

An external package's prebuilt executable imports:

```ts
import { serveHarness } from '@paperclipai/runner-sdk/host';
import { parseRunnerHarnessReleaseIdentity } from '@paperclipai/runner-sdk/contracts';

// Read immutable launch input supplied by the trusted installer/Runner.
// Do not derive your expected identity from an unverified initialize request.
const identity = parseRunnerHarnessReleaseIdentity(admittedLaunch.identity);

await serveHarness({
  identity,
  capabilities: { interruption: true, resume: true, typedEvents: true },
  async initialize({ snapshot }, context) {
    // Restore exactly the admitted native session when snapshot is present.
    // A failed restoration must not silently start another conversation.
    await nativeRuntime.open({ snapshot, signal: context.signal });
    return {};
  },
  async execute(command, context) {
    // Acknowledge admission, then report native work through context.emit().
    // Register tools/instructions before accepting the first prompt.
    return nativeRuntime.dispatch(command, context);
  },
  async snapshot() { return nativeRuntime.snapshot(); },
  async close() {
    await nativeRuntime.dispose();
    return {};
  },
});
```

This example names provider-owned operations, not SDK implementations. The host
does not start a provider, discover packages, install dependencies, or contact a
control plane. The external integration implements those native operations.

## Wire and ownership

[`protocol/harness.schema.json`](protocol/harness.schema.json) describes the
newline-delimited UTF-8 JSON protocol. Every frame names `paperclip.harness.v1`.
The maximum frame is 1 MiB; JSON depth and node counts are also bounded.

- `initialize` accepts the admitted `identity`, run/session IDs and optional
  snapshot. The host replies with its exact identity and capability claims.
- `execute` receives `{ command }`, preserving the complete PRP command envelope.
  Its response is a provider-owned JSON result. An admission receipt is not work
  completion.
- `snapshot` returns bounded provider-specific checkpoint data.
- `close` revokes admission and awaits native teardown. EOF invokes the same
  cleanup exactly once.

Events carry a host-assigned increasing sequence, normalized `eventType`, priority
(`p0`, `p1`, `p2`), optional turn/item IDs and JSON payload. Await `context.emit()`
to preserve backpressure. Runner validates allowed provider event types, binds its
own identities, and persists PRP delivery; a harness cannot publish Runner-owned
control facts or decide task status.

For an authorized `paperclip_finish` or `paperclip_block` tool call, publish
`semantic_tool.input` and await its `semantic_tool.result` callback. Core validates
and normalizes the completion and publishes the canonical result in the native
session. A successful callback does not require a second provider
`run.result.proposed` event. Return its feedback to the native harness, then
forward the native final response and turn terminal normally.

Never publish raw completion tool arguments as a PRP result payload. A separate
`run.result.proposed` event requires the complete `paperclip.run_result.v1` shape,
including `artifacts` and `attentionRequests` arrays. JSONL frame validation alone
does not validate every PRP event payload. Integration tests can use Paperclip
Runner's public `validatePrpEvent` to check those normalized facts.

Runner wraps native snapshot data in a `RunnerHarnessCheckpoint`, binding the
exact release, normalized session, model, configuration, workspace and credential
revision. A settled per-turn conversation can import that checkpoint in a fresh
Runner authority epoch after the previous process group is absent. The harness
must restore its native state and return the same native session identity.
Starting another conversation is a failed recovery. Prior accepted Paperclip
events stay in the original run's ledger; the package does not recreate them as
provider history. Active-turn and live-process authority handoffs are unsupported
by this version of the extension contract.

An extension can emit `runtime_request.created` with a canonical
`paperclip.runtime_request.v2` request. Use `requestKind: "runtime"` and a
`paperclip.question_set.v1` input for questions, or `command_approval`,
`file_approval`, or `permission_approval` for approvals. Include the unique request
ID, pending status, prompt, native item ID and the admitted correlation turn ID.
No other provider's native origin method is required. Runner returns the exact
request ID in `request.resolve`; apply the typed response or resolution, then
emit its settled outcome. An approval applies only to the admitted operation;
the package must not turn it into a broader company or filesystem grant.

Commands normally serialize. Stop/interruption and tool/input callback results
can proceed while an earlier handler is awaiting work. Cancellation aborts its
context and prevents that handler from publishing late events. Handlers must
observe the signal, release provider resources, and distinguish native activity
completion from a whole-agent idle observation. The host's cleanup deadline is
bounded; Runner remains responsible for physically stopping the process group.

Do not write diagnostics to stdout. Handler errors receive sanitized generic
responses unless they are explicit `HarnessProtocolError`s. Never put credentials
in protocol errors. Persist durable human waits through Paperclip; process-local
provider callbacks must expire when their native process is lost.

## Verification

Build with `pnpm --filter @paperclipai/runner-sdk build`, then run
`pnpm --filter @paperclipai/runner-sdk test`. Tests cover parser limits, confined
declarations, immutable identity handshakes, stream lifecycle, interruptible
callbacks and cleanup. The clean-consumer test packs the real npm package and
installs it offline into an independent temporary project, checking its public
exports and empty runtime dependency graph.

External repositories can import `runHarnessProcessConformance` from
`@paperclipai/runner-sdk/testing`. Supply an absolute executable and cwd, its exact
admitted identity, explicit fixture commands, required normalized event types and
a total deadline. It drives a real subprocess through initialize, commands and
close, checks event ordering and exact identity, and verifies a clean exit.
Snapshot conformance is required when the harness advertises `resume: true` or the
caller sets `requireSnapshot: true`. A one-shot harness can omit its snapshot
handler; successful one-shot reports omit `snapshot`. On failure it reaps its owned process group. Only PATH and explicitly
supplied environment values reach the child; provider diagnostics are consumed
without entering the report. The test kit never downloads a package or chooses
a model on the caller's behalf.

These tests establish the SDK boundary. A real harness must additionally qualify
its provider behavior and the complete Paperclip setup/run/recovery/Stop journey.
