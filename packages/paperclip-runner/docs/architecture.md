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
                         byte-identical Phase 0 result

Paperclip core (later) --> implements ControlPlanePort / NativeSessionBackend
```

The dependency arrow always points from an implementation toward a contract.
The standalone package does not reach backward into a Paperclip implementation.

## Initial contracts

- `ControlPlanePort` is the narrow surface through which a runner opens a run,
  appends ordered events, and submits a terminal structured result.
- `HarnessDriver` owns a local harness session and its provider-specific
  identity, event, turn, snapshot, and close behavior.
- `NativeSessionBackend` normalizes local runner and hosted-provider sessions for
  a future control-plane consumer. Environment placement is not implied by the
  backend type.

The Phase 0 TypeScript contracts are deliberately sketches: they name
responsibility and dependency direction without prematurely implementing the
runtime transport. Phase 1 adds this executable static path:

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
boundary and checks the same fixture summaries. Phase 2 adds the package-local
`paperclip-runnerd` and `fake-harness` binaries without changing that dependency
direction.

## Language ownership

- Rust is the production direction for deterministic runner behavior,
  supervision, durable delivery, and the eventual `paperclip-runnerd` binary.
- TypeScript owns the control-plane/browser side and remains a useful reference
  client/test oracle.
- JSON Schema and shared fixtures are the language-neutral authority. Phase 0
  keeps its narrow tracer fixture; Phase 1 adds the executable PRP v1 schema and
  conformance corpus without silently changing the accepted Phase 0 path.
- `check:phase0-parity` prevents either implementation from introducing a
  language-specific observable result.
- `check:phase1-parity` prevents TypeScript replay and the Rust production
  direction from disagreeing on identity, terminal state, duplicates, or gaps.

## Allowed dependencies

- Rust crates declared by the package-local Cargo workspace.
- Node.js standard-library modules.
- Third-party packages declared by this workspace when a later phase needs them.
- Files within `packages/paperclip-runner/`.
- A future explicit generated-schema package only after architecture review and
  an allowlist change in the boundary checker.

## Forbidden dependencies

The following imports and package dependencies are rejected:

- `server/`, `ui/`, and `cli/` implementation paths;
- `@paperclipai/db` and production database schema or client modules;
- `@paperclipai/shared`, adapter utilities, and other Paperclip workspace
  internals unless a later boundary review explicitly allows a public contract;
- relative or absolute imports that escape `packages/paperclip-runner/`.

This rule applies to type-only imports, exports, dynamic imports, CommonJS
`require` calls, Rust include/path attributes, and Cargo path dependencies. The
negative fixtures under `test-fixtures/` intentionally reference `server/` and
must fail the checker.

## Enforcement

```sh
pnpm --filter @paperclipai/paperclip-runner check:forbidden-imports
pnpm --filter @paperclipai/paperclip-runner test
pnpm --filter @paperclipai/paperclip-runner check:phase1-parity
```

The first command scans the package source, scripts, and manifest. The test
command additionally asserts that the negative fixture is rejected. The normal
scan excludes that fixture so a deliberate proof does not make the package fail.

## Phase 0 process boundary

The mock core is an in-memory adapter, not a Paperclip server. Starting it only
changes local object state. The tracer performs this sequence:

1. load and validate `protocol/fixtures/phase-00-minimal-run.json`;
2. start the mock adapter;
3. open the fixture run through `ControlPlanePort`;
4. append contiguous typed events;
5. submit the matching terminal result;
6. print a stable JSON identity/result and stop the adapter.

No socket, database, browser, Paperclip process, or model process is started.
The default command executes this sequence in Rust. The TypeScript reference
executes the same sequence, and the parity check compares their complete stdout.

## Phase 1 static replay boundary

`replayPhase1FixtureText` is the single entry point used by the CLI and browser.
It parses JSON, validates JSON Schema plus cross-record bindings, and only then
calls the reducer. The reducer is pure: it clones input state, applies an event
at most once by source event ID, records source gaps/out-of-order deliveries,
and never performs I/O.

The browser is a Vite application under `devtools/browser/`. Its Button, Badge,
Card, and Textarea are source-compatible adaptations of shadcn primitives; all
visual values live in its local `styles.css` token layer. It imports the same
replay module as the CLI and does not create a browser-only protocol model.

## Phase 2 local process boundary

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

## Phase 3 durable transport boundary

```text
TypeScript mock core
  | one-time ticket -> short-lived connection lease
  | PRP v1 hello/welcome, commands, events, cumulative ACKs
  v
paperclip-runnerd (Rust WebSocket client)
  | atomic private JSON state
  +-- durable outbox and processed-command cache
  +-- stable runner/session/turn/item identities
  +-- Phase 2 fake-harness process for restart proof
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

## Future integration rule

The [implementation plan](../spec/paperclip-native-runner-implementation-plan.md)
keeps production integration in a separately reviewed phase. Paperclip core may
implement these contracts later, but this package must remain independently
buildable, testable, and runnable against the mock adapter.

The proposed Phase 6 seam is recorded in
[Phase 6 Thin Paperclip Adapter Boundary](design/phase-6-thin-paperclip-adapter.md).
It keeps one dependency direction, branches only after Paperclip workspace and
environment realization, composes a package-owned `NativeSessionBackend` with
a server-bound `ControlPlanePort`, and returns to the existing Paperclip
finalization path. The core seam contains no runner behavior. The proposal is
design-only until the CTO gate accepts it.
