# Paperclip Runner

This private workspace package contains the staged Paperclip Runner work.

The package currently exposes the language-neutral PRP v1 TypeScript
contract, provider-neutral structured questions and responses, deterministic
fixture validation/replay, structured-result normalization, and the session
reducer oracle. It also contains a package-local Rust runner, scripted fake
harness, bounded process supervisor, cross-language replay oracle, and durable
PRP transport. The transport authenticates and encrypts loopback WebSocket
sessions, persists an ACK-driven outbox and command journal, and reconnects with
a short-lived lease. The Rust runner now includes a Codex-only app-server
provider bridge with durable thread resume, cancellation, structured questions,
and provider-neutral event normalization. The root surface now also exposes an
authenticated durable PRP authority for server-side use. It stores only
bootstrap and reconnect credential digests, validates immutable run identity on
every connection and event, and persists commands and cumulative event ACK
state across server restarts.
The package also publishes the canonical semantic action declarations and
their input and output schemas. Its package-local dispatcher projects only
bound, run-authorized actions and emits redacted semantic receipts.

The first and only provider selected directly by runnerd remains Codex. The
package also contains the qualified OpenCode 1.18.17 proxy and the bounded ACPX
sidecar for Codex and Claude, but this slice does not authorize the server
to select those additional providers for a fresh native run. Dynamic semantic
tools remain undiscoverable unless the hidden server coordinator projects one
of the five same-task read bindings for an already persisted native Codex run.
Catalog membership alone does not grant authority. The server can now create
and start a Codex-backed native run only through the default-off
`paperclip_runner` adapter. See
[`SEMANTIC_ACTIONS.md`](SEMANTIC_ACTIONS.md) for the catalog boundary.

The package has two initial public surfaces:

- `@paperclipai/paperclip-runner` contains runtime contracts, validation,
  replay/reducer logic, the semantic catalog, the authorization dispatcher, and
  the Node-only durable server authority.
- `@paperclipai/paperclip-runner/testing` adds Node-only fixture loading and a
  provider-neutral semantic conformance kit for deterministic test adapters.

No SDK, browser, React, eval, live-console, or lab entry point is exported. The
package remains private in this wave. The server route
at `/api/runner/v1/connect/:runId` has no authority until the hidden coordinator
registers an exact existing run binding. Fresh native starts are rejected
unless the instance `enableNativeRunner` flag is enabled. Existing direct
adapters keep their original execution path.

The package build compiles the release `paperclip-runnerd` executable and
stages it under `dist/bin`. The normal server build vendors that directory, so
an installed server does not depend on a separate system Rust installation or
a manually copied binary. `pnpm-lock.yaml` remains under the repository's
existing lockfile process.

The `paperclip-runner-opencode-proxy` binary adapts the pinned OpenCode server
protocol to the normalized harness contract. It admits only a bounded provider
environment, uses an authenticated loopback MCP endpoint, validates dynamic
tool inputs, keeps terminal completion tools private to the runner boundary,
and preserves exact provider session identity for recovery. The backend factory
requires an explicit runtime directory before constructing this provider.

The package also builds `paperclip-runner-acpx-sidecar`. This bounded v2
stdin/stdout bridge admits the closed Claude and Codex ACPX profiles. It
validates each agent's exact package/model pair, session identity, tool catalog,
structured input, and terminal settlement at the process boundary. Claude runs
without ambient project or local settings. Pi remains unavailable until its
separately spawned runtime can use the same descriptor-confined verified launch
boundary as the ACP server. Runnerd and the server do not select this sidecar
in this slice.

The Rust core includes a bounded client for this sidecar protocol. It enforces
request identity, event order, frame and queue limits, timeouts, redacted
diagnostics, and process-group cleanup. This transport remains package-local.
It does not change runnerd provider selection in this slice.

Before a later provider adapter consumes a valid sidecar event, the Rust core
also requires its optional or mandatory run and turn scope to match the active
execution. Process and diagnostic events can remain global. All operational,
tool, input, permission, and terminal events require the exact active binding.

A package-local payload boundary decodes events only after that scope check. It
validates control identities, terminal status, question sets, and the admitted
runtime event types and bounded fields. It redacts diagnostic and retained
event values again before they can enter provider state.

Validated ACPX runtime events normalize into the same provider-neutral activity
families as the direct Codex transport. Reasoning contents stay private. Tool
targets are resolved within the workspace under the provider host's path
semantics and receive a versioned sidecar boundary marker before becoming
bounded, display-only PRP safe paths. Raw or unmarked provider locations fail
closed. URI-scheme and Windows drive-shaped values require a separate sidecar
attestation backed by an existing in-workspace entry or, for a not-yet-created
edit target, an existing in-workspace parent. This preserves real POSIX colon
filenames without treating arbitrary URI text as a path. Windows separators
are canonicalized, and consumers must not reinterpret the display value as
file-access authority. Operational semantic-result and terminal events remain
reserved for the stateful adapter rather than being duplicated.

The package-local ACPX provider reducer preserves that order while it tracks one
active turn, bounded assistant text, semantic results, and pending tool or input
correlations. Terminal events flush the final assistant message first and clear
unresolved turn-scoped requests. This reducer still does not select ACPX in
runnerd.

The package-local session bootstrap starts the bounded sidecar transport,
verifies the selected qualified capability handshake and effective model, opens one
identity-bound session, and confirms its run attachment. Any failed bootstrap
terminates the process; session shutdown preserves persistent provider state.
The session can then start one immutable-workspace turn, request interruption,
and reduce polled events through the scope-first state boundary. A mismatched
command acknowledgement or invalid event terminates the session fail closed.
Polled semantic calls pass through the run-scoped authorized tool bridge before
they can be returned to a caller. Before a follow-up turn releases settled tool
receipts, runner-core suspends and reaps the idle sidecar/provider generation,
then resumes the same verified persistent identity in a fresh generation. This
prevents a late session-lifetime MCP callback from inheriting the next turn's
event authority.

The Rust question-response validator checks the versioned response envelope
against the exact persisted question IDs, answer modes, options, required
answers, custom-answer policy, and text constraints before provider delivery.
Tool results and structured question responses then use two-phase resolution:
validate retained identity and schema, require the exact sidecar
acknowledgement, and only then clear pending local state. Permission events that
escape the pinned sidecar policy terminate the session fail closed.
Safe suspension is available only with no active turn or pending request. The
sidecar must return the exact persistent session identity before runnerd
terminates the local process.
Already validated ACPX reducer events project into provider-neutral durable
events only with an exact run, session, turn, and item binding. Raw sidecar
envelopes and permission requests are not admitted at this boundary.
A safely suspended session can be recorded as a bounded private checkpoint.
The checkpoint binds the exact provider identity, run, catalog revision, and
catalog digest and is replaced atomically before a later recovery attempt.
Recovery releases the stored identity only after those bindings match the
prospective session configuration exactly.

Run the complete contract gate with:

```sh
pnpm --filter @paperclipai/paperclip-runner check:protocol
```

Run the Rust runner gate with:

```sh
pnpm --filter @paperclipai/paperclip-runner check:runner
```

This command checks Rust formatting, builds and tests the minimal workspace in
release mode, verifies bounded process cleanup, launches the real
`paperclip-runnerd` binary through the fake harness, and compares the Rust
conformance and replay summaries with the shared fixtures. The checked-in Cargo
lock and pinned Rust toolchain keep this verification reproducible.

Durability and failure semantics are documented in
[`runner/DURABLE_TRANSPORT.md`](runner/DURABLE_TRANSPORT.md). The fault suite
drops a connection before its event ACK, reconnects with the bound lease,
replays the same event, and proves the duplicated command effect ran once.
Codex launch, resume, cancellation, and normalization behavior is documented in
[`runner/CODEX_PROVIDER.md`](runner/CODEX_PROVIDER.md).

Use `generate:protocol-manifest` after a schema or fixture change,
`generate:protocol-types` after a schema change, and
`generate:replay-goldens` after an intentional reducer change. Commit generated
outputs with their sources; do not edit them by hand.

Use `generate:semantic-action-catalog` after changing a semantic action
declaration. Its checked-in JSON inventory must land with the source change.

The gate compiles every schema with AJV 2020-12, validates accepted fixtures,
rejects unsupported required versions, checks generated TypeScript schema
drift, runs the TypeScript contract tests, and compares reducer snapshots and
parity summaries byte-for-byte with their checked-in golden files.
