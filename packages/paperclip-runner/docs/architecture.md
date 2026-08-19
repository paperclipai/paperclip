# Architecture and Standalone Boundary

## Dependency direction

```text
                         language-neutral protocol fixture
                                      |
                      +---------------+---------------+
                      v                               v
         Rust runner-core + mock path      TypeScript contracts + mock path
                      |                               |
                      +---------------+---------------+
                                      v
                         byte-identical Conformance result

Paperclip App production binding --> implements ControlPlanePort
Paperclip Evals --> consumes packed runtime + ./evals + ./testing exports
```

The dependency arrow always points from an implementation toward a contract.
The standalone package does not reach backward into a Paperclip implementation.
The production implementation lives in
`server/src/services/native-runtime/paperclip-control-plane-port.ts`; it depends
on the public port, never the reverse. The accepted package/export ownership is
recorded in [ADR 0001](adr/0001-runner-testing-eval-package-boundaries.md).

## Public package surfaces

- The package root is runtime-only: PRP, runner/client contracts, normalized
  backends, catalog/dispatcher, and compatibility preflight.
- `./evals` is the stable integration join: native attempt schema/fixture,
  build metadata, complete package/binary/PRP/catalog/driver negotiation, and
  explicit digest-verified runnerd artifact resolution.
- `./testing` contains deterministic mocks and conformance kits.
- `@paperclipai/paperclip-eval-kernel` contains generic orchestration only and
  is permitted in App CI/tests as a development dependency, never at runtime.
- Paperclip Evals owns scenario content, matrices, provider configuration,
  scoring, and reports.

## Core contracts

- `ControlPlanePort` is the narrow surface through which a runner opens a run,
  appends ordered events, and submits a terminal structured result.
- `HarnessDriver` owns a local harness session and its provider-specific
  identity, event, turn, snapshot, and close behavior.
- `NativeSessionBackend` normalizes local runner and hosted-provider sessions for
  a future control-plane consumer. Environment placement is not implied by the
  backend type.

The TypeScript contracts name responsibility and dependency direction while
the executable replay path provides a deterministic oracle:

```text
protocol/schemas/*.json
        | generate/check                 | shared fixtures
        v                                v
TypeScript schema constants/types -> validator -> deterministic reducer
                                                |              |
                                                v              v
                                               CLI        browser devtool
                                                |
                                      golden parity summaries
                                                |
                                                v
                                      Rust runner-core oracle
```

The Rust `runner-core` crate establishes the production language/package
boundary and checks the same fixture summaries. Local runner adds the package-local
`paperclip-runnerd` and `fake-harness` binaries without changing that dependency
direction.

Evals receives runnerd as a separate content-addressed artifact. The package
does not discover or bundle a host-specific executable: the consumer supplies
an explicit path and digest, then reads versioned metadata from that exact
binary. See [the Evals integration contract](evals-integration.md).

## Language ownership

- Rust is the production direction for deterministic runner behavior,
  supervision, durable delivery, and the eventual `paperclip-runnerd` binary.
- TypeScript owns the control-plane/browser side and remains a useful reference
  client/test oracle.
- JSON Schema and shared fixtures are the language-neutral authority. Conformance
  keeps its narrow tracer fixture; Replay adds the executable PRP v1 schema and
  conformance corpus without silently changing the accepted Conformance path.
- `check:conformance-parity` prevents either implementation from introducing a
  language-specific observable result.
- `check:replay-parity` prevents TypeScript replay and the Rust production
  direction from disagreeing on identity, terminal state, duplicates, or gaps.

## Allowed dependencies

- Rust crates declared by the package-local Cargo workspace.
- Node.js standard-library modules.
- Third-party packages declared by this workspace.
- Files within `packages/paperclip-runner/`.
- A future explicit generated-schema package only after architecture review and
  an allowlist change in the boundary checker.

## Forbidden dependencies

The following imports and package dependencies are rejected:

- `server/`, `ui/`, and `cli/` implementation paths;
- `@paperclipai/db` and production database schema or client modules;
- `@paperclipai/shared`, adapter utilities, and other Paperclip workspace
  internals unless a boundary review explicitly allows a public contract;
- relative or absolute imports that escape `packages/paperclip-runner/`.

This rule applies to type-only imports, exports, dynamic imports, CommonJS
`require` calls, Rust include/path attributes, and Cargo path dependencies. The
negative fixtures under `test-fixtures/` intentionally reference `server/` and
must fail the checker.

## Enforcement

```sh
pnpm --filter @paperclipai/paperclip-runner check:forbidden-imports
pnpm --filter @paperclipai/paperclip-runner test
pnpm --filter @paperclipai/paperclip-runner check:replay-parity
```

The first command scans the package source, scripts, and manifest. The test
command additionally asserts that the negative fixture is rejected. The normal
scan excludes that fixture so a deliberate proof does not make the package fail.

## Conformance process boundary

The mock core is an in-memory adapter, not a Paperclip server. Starting it only
changes local object state. The tracer performs this sequence:

1. load and validate `protocol/fixtures/conformance-minimal-run.json`;
2. start the mock adapter;
3. open the fixture run through `ControlPlanePort`;
4. append contiguous typed events;
5. submit the matching terminal result;
6. print a stable JSON identity/result and stop the adapter.

No socket, database, browser, Paperclip process, or model process is started.
The default command executes this sequence in Rust. The TypeScript reference
executes the same sequence, and the parity check compares their complete stdout.

## Static replay boundary

`replayReplayFixtureText` is the single entry point used by the CLI and browser.
It parses JSON, validates JSON Schema plus cross-record bindings, and only then
calls the reducer. The reducer is pure: it clones input state, applies an event
at most once by source event ID, records source gaps/out-of-order deliveries,
and never performs I/O.

The browser is a Vite application under `devtools/browser/`. Its Button, Badge,
Card, and Textarea are source-compatible adaptations of shadcn primitives; all
visual values live in its local `styles.css` token layer. It imports the same
replay module as the CLI and does not create a browser-only protocol model.

## Local process boundary

```text
TypeScript mock core
  | PRP commands over stdin JSONL
  v
paperclip-runnerd (Rust supervisor)
  | fake-harness commands over stdin JSONL
  v
fake-harness (Rust scripted driver)
  | typed messages over stdout JSONL
  v
paperclip-runnerd -> canonical PRP events -> mock core
                                      |
                                      v
                              browser NDJSON stream
```

The mock core starts one runner process. The runner creates a new process group
for one fake harness and its workers. The runner clears the inherited
environment and restores only the path needed to launch local executables. It
captures stderr and scripted log messages in a bounded tail.

The controller and harness links use newline-delimited JSON over stdio. This is
the smallest local transport that keeps process ownership clear. The browser
does not connect to the runner. A package-local Vite middleware exposes an HTTP
start/action API and an NDJSON event stream from the TypeScript mock core.

The runner publishes the structured semantic result before it publishes the
harness process exit fact. It then emits one `run.terminal` event. A non-zero
harness exit can coexist with a valid yielded result. Duplicate commands and
duplicate terminal messages cannot repeat side effects or close the run twice.

Every browser event passes `validatePrpEvent` and `applyPrpEvent`. When the run
ends, the browser reduces the complete event list again and compares the replay
snapshot with the live snapshot.

## Durable transport boundary

```text
TypeScript mock core
  | one-time ticket -> short-lived connection lease
  | PRP v1 hello/welcome, commands, events, cumulative ACKs
  v
paperclip-runnerd (Rust WebSocket client)
  | atomic private JSON state
  +-- durable outbox and processed-command cache
  +-- stable runner/session/turn/item identities
  +-- Local runner fake-harness process for restart proof
```

The runner initiates the loopback WebSocket. The bootstrap ticket is present
only in the runner process environment. The returned connection-lease token is
kept only in runner memory. The mock core stores SHA-256 digests of capabilities
and the runner state stores neither capability. The runner writes each event and
command result before network delivery, then removes outbox events only after a
valid cumulative ACK.

The TypeScript peer is a package-local test controller, not production
Paperclip. It injects lost ACKs, socket loss, malformed input, process restarts,
lease expiry, storage pressure, drain, and revoke. The browser recovery page
calls that peer through guarded package-local Vite middleware and renders only
safe trace fields.

## Capability-model boundary

```text
Paperclip skill + 7 references        Paperclip Evals corpus (106 cases)
            |                                      |
            +-------------------+------------------+
                                v
                generated capability contract (258 rows, 41 MCP aliases)
                                |
        +-----------------------+-----------------------+
        v                       v                       v
 semantic tool catalog   authorization engine    eval conformance suite
        \                       |                       /
         \                      v                      /
          +-----> in-process mock ControlPlanePort <--+
                                |
                                v
                   read-only browser scenario explorer
```

Capability is a package-local model of a native Paperclip run. It classifies every
capability as control-plane-owned, always-agent-tool, or optional-agent-tool,
exposes the always/optional set as a transport-neutral semantic tool catalog,
gates optional tools behind grants, and proves 106 eval-derived cases against an
in-process mock `ControlPlanePort`. The mock adapter is the only coupling point,
so a real adapter can replace it later without touching the catalog,
authorization rules, or conformance suite. Capability contacts no Paperclip
service, database, ACPX session, or provider credential; the
[forbidden-imports checker](#forbidden-dependencies) keeps it that way. Real
integration is future upload integration (ACPX) and requires separate approval; see
[the future binding boundary](capability-future-binding-boundary.md).

## Capability live process topology

The live surface adds a real provider turn loop over the same mock core. The
package server owns every credential and every child process; the browser holds
none.

```text
 browser (issue thread + evidence panel; no credential)
        |  HTTP/SSE over the trusted-proxy boundary
        v
 package server ── projectCapabilityIssueThread ──> CapabilityIssueThreadSnapshot
        |                                          (one contract, two producers)
        |  owns session, tool loop, provider auth
        v
 paperclip-runnerd (real binary, owns the Codex process group)
        |  newline-delimited JSON-RPC over stdio
        v
 codex app-server (real session)
        |  tool request
        v
 CapabilitySemanticDispatcher ── typed command ──> in-process mock ControlPlanePort
        ^                                          |
        +──────── typed result / typed denial ─────+
```

Three actors stay separate at all times: **Real Codex** (the app-server
session), **Real runnerd** (the package-local binary), and **Mock Paperclip**
(the in-process `ControlPlanePort`). The same
`CapabilityIssueThreadSnapshot` is produced by deterministic `fake` fixtures for the
screenshot matrix and by the server-side projection for a live session; the
projection reads only durable records and decides nothing, so UI-side state math
is a defect by construction. The scripted (`fake`) mode drives the conformance
suite and replay offline; the Codex (live) mode requires a locally authenticated
Codex. See [execution modes and identity](capability-execution-modes.md) for the
mode and eligibility rules, and [the live runnerd/Codex loop](capability-live-runnerd-codex.md)
for the session API. The package server blocks every request to a real
Paperclip API, and the evidence suite proves no such request occurred. The same
topology serves the [clean-room chat](capability-clean-room-chat.md): the only
difference is a mock tenant seeded with a company, an agent, and one blank issue
instead of a recorded eval case.

## Integration rule

Paperclip core may implement these contracts behind a separately reviewed
adapter, but this package must remain independently buildable, testable, and
runnable against the mock adapter.

The proposed Standalone seam is recorded in
[Standalone Thin Paperclip Adapter Boundary](design/standalone-thin-paperclip-adapter.md).
It keeps one dependency direction, branches only after Paperclip workspace and
environment realization, composes a package-owned `NativeSessionBackend` with
a server-bound `ControlPlanePort`, and returns to the existing Paperclip
finalization path. The core seam contains no runner behavior. The proposal is
design-only until the CTO gate accepts it.
