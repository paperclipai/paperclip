# Paperclip Native Runner

This workspace is the standalone development boundary for Paperclip's native
runner protocol, harness drivers, and normalized session backends. The
production runner direction is Rust; `runner/` is its Cargo workspace. The
TypeScript surface remains a control-plane/client reference implementation.
Phase 0 runs both implementations against one language-neutral fixture. Phase 1
adds executable PRP schemas, a cross-language conformance corpus, deterministic
static replay, and a standalone browser reference page. Phase 2 adds the Rust
runner process, process-group supervision, a scripted fake harness over stdio
JSONL, a TypeScript mock core, and validated live browser replay. Phase 3 adds
the Rust outbound WebSocket client, private durable state, replay and restart
recovery, and safe CLI/browser diagnostics. Phase 4 adds a direct, skillless
Codex app-server driver, semantic completion tools, canonical event tracing,
and a real-model example against the mock core. These phases do not import or
start Paperclip's server, UI, CLI, or production database. The Phase 4b lower
layer adds browser-resolved provider requests, goal capability detection,
subagent lineage, control-race semantics, and a package-local demo server that
keeps Codex authentication server-side. The Phase 4b live console adds the
browser tracer over that boundary: a live transcript and composer, same-turn
steering, three distinct interrupt races, inline request cards,
capability-gated goal controls, parent/child lineage, reconnect, refresh,
replay, and a redacted protocol inspector. Phase 5 extracts that accepted
transport, reducer projection, hook, components, styles, and reference console
into versioned public subpaths, then proves the surface with a second minimal
consumer.
Phase 6 adds a default-off Paperclip adapter at the public control-plane/session
boundary, durable PRP replay and result finalization, and a kill switch that
keeps the legacy adapter path as the default.
Its audit-only attention path also terminates through the public port/finalizer
call graph: duplicate and stale requests commit exact interaction receipts with
no status decision, wake, notification, or issue status/version change, and a
committed coordinator makes replay a no-op.
Phase 7D adds the stable semantic-tool catalog, actor/task/mode/scenario policy,
invocation-time dispatcher checks, typed denials, redacted authorization
records, and one provider-neutral contract shared by fake and live Codex
bindings. Phase 7E starts a real package-local runnerd and Codex app-server,
routes allowed semantic calls through the mock `ControlPlanePort`, resumes the
same provider thread, and performs bounded process-group cleanup. The data plane
remains mock-only and package-local.

## Phase 0–5 quick start

From the repository root:

```sh
pnpm install --filter @paperclipai/paperclip-runner --lockfile=false --offline --ignore-scripts --dev
pnpm --filter @paperclipai/paperclip-runner verify
```

The verification command requires a stable Rust toolchain with `cargo` on
`PATH`, in addition to Node.js 20+ and pnpm 9+.

Minimal Debian/Ubuntu hosts without root access can extract the required
Playwright browser libraries into a user-owned cache and run the same acceptance
sequence with:

```sh
pnpm --filter @paperclipai/paperclip-runner verify:rootless
```

The tracer's final line is stable:

```json
{"schemaVersion":"paperclip.runner.phase0.output.v1","runIdentity":{"runId":"run_phase0_0001","sessionId":"session_phase0_0001"},"result":{"status":"succeeded","summary":"Standalone Phase 0 fixture accepted."}}
```

Run only the tracer with:

```sh
pnpm --filter @paperclipai/paperclip-runner trace:phase0
```

Replay the Phase 1 happy path, run a Phase 2 local session, or open the browser
devtool:

```sh
pnpm --filter @paperclipai/paperclip-runner replay:phase1
pnpm --filter @paperclipai/paperclip-runner trace:phase2 -- --scenario happy-path
pnpm --filter @paperclipai/paperclip-runner trace:phase3 -- --fault lost-ack
pnpm --filter @paperclipai/paperclip-runner trace:phase4
pnpm --filter @paperclipai/paperclip-runner demo:phase4b -- --host 127.0.0.1 --port 4174

# Phase 4b: chat with a live session in the browser.
pnpm --filter @paperclipai/paperclip-runner console:phase4b
pnpm --filter @paperclipai/paperclip-runner browser:dev --host 127.0.0.1 --port 4179

# Phase 5: open the public-SDK reference console and mini consumer.
pnpm --filter @paperclipai/paperclip-runner console:phase5

# Phase 6: prove the mock-side integration contract.
pnpm --filter @paperclipai/paperclip-runner trace:phase6 -- --target mock --scenario happy-path
```

Phase 4b provider-backed routes are loopback-only and reject wildcard/LAN
binds. Browser mutations require same-origin Fetch Metadata, matching Origin,
and JSON content; see the protocol-server tutorial for direct `curl` examples.

## Package-owned commands

| Command | Purpose |
|---|---|
| `build` | Compile the TypeScript public surface, Rust workspace, and browser devtool. |
| `typecheck` | Check TypeScript, Rust, generated schema sources, and browser types. |
| `test` | Run Rust/TypeScript fixture, supervisor, fake-driver, live/replay, and boundary tests. |
| `check:forbidden-imports` | Reject TypeScript imports and Cargo path dependencies that cross into Paperclip core. |
| `check:phase0-parity` | Require byte-for-byte equivalent Rust and TypeScript tracer output. |
| `check:phase1-goldens` | Require all reducer snapshots and cross-language summaries to match checked goldens. |
| `check:phase1-parity` | Run TypeScript and Rust against the same Phase 1 fixture summaries. |
| `check:browser-tokens` | Reject component-local visual literals and require the standalone token layer. |
| `docs:validate` | Validate local documentation links and the OKF v0.2 bundle. |
| `trace:phase0` | Run the Rust mock-core tracer, print the stable result, and exit. |
| `trace:phase0:typescript` | Run the TypeScript reference tracer directly. |
| `replay:phase1` | Validate and reduce a fixture to a final snapshot. |
| `trace:phase2` | Run one native local session through the Rust runner and fake harness. |
| `record:phase2` | Capture a validated happy-path live trace as a replay fixture. |
| `trace:phase3` | Run the Rust runner against the mock core with a selected recovery fault. |
| `record:phase3` | Regenerate the complete Phase 3 fault matrix and exact per-fault traces. |
| `trace:phase4` | Run the mock core with a real, local skillless Codex app-server session. |
| `record:phase4` | Run the safe Codex task and record its validated, normalized trace. |
| `demo:phase4b` | Start the package-local HTTP/SSE server with server-only Codex authentication. |
| `console:phase4b` | Start the standalone browser devtool with the Phase 4b live console on `127.0.0.1:4180`. |
| `record:phase4b` | Run a safe real Codex task through the demo server and record reconnect/replay evidence. |
| `console:phase5` | Start the public-SDK reference console and mini consumer on `127.0.0.1:4181`. |
| `test:phase5` | Run targeted browser-client, reducer-projection, and React component contract tests. |
| `check:phase-07-contract` | Verify the Phase 7A skill, MCP, and eval traceability contract. |
| `generate:semantic-contracts` | Compile and regenerate the provider-neutral Phase 7D tool contract. |
| `check:semantic-contracts` | Fail when the checked-in Phase 7D tool contract is stale. |
| `test:phase7` | Prove the Phase 7 mock adapter, semantic policy, live session persistence, interaction resume, stop, and reset contracts. |
| `trace:phase7` | Run a real runnerd and Codex app-server semantic-tool smoke with process and network evidence. |
| `test:browser:phase5` | Exercise both consumers with the fake driver, keyboard/a11y checks, reconnect/replay, measurements, and screenshots. |
| `record:phase5:codex` | Run both public consumers against a safe real Codex session and capture live screenshots. |
| `browser:dev` | Start the standalone live/replay/recovery browser devtool. |
| `test:browser` | Exercise static replay and live scenarios, then capture temporary screenshots under ignored test output. |
| `verify` | Run the complete deterministic Phase 0 through Phase 5 acceptance sequence. |
| `verify:rootless` | Extract Debian/Ubuntu browser libraries without root, then run `verify`. |

## Navigate

- [Architecture and dependency boundary](docs/architecture.md)
- [Tutorial index](docs/index.md)
- [Phase 0 hand-run tutorial](docs/tutorials/phase-00-standalone-tracer.md)
- [Phase 1 hand-run tutorial](docs/tutorials/phase-01-static-replay.md)
- [Phase 2 hand-run tutorial](docs/tutorials/phase-02-local-runner.md)
- [Phase 2 local protocol reference](docs/phase-02-local-protocol.md)
- [Phase 3 break-it-on-purpose tutorial](docs/tutorials/phase-03-break-recovery.md)
- [Phase 3 durable transport reference](docs/phase-03-durable-transport.md)
- [Phase 4 skillless Codex tutorial](docs/tutorials/phase-04-skillless-codex.md)
- [Phase 4 skillless Codex driver reference](docs/phase-04-skillless-codex-driver.md)
- [Phase 4b protocol/server tutorial](docs/tutorials/phase-04b-protocol-server.md)
- [Phase 4b protocol/server reference](docs/phase-04b-protocol-server.md)
- [Phase 4b live console tutorial](docs/tutorials/phase-04b-live-console.md)
- [Phase 4b live console reference](docs/phase-04b-live-console.md)
- [Phase 5 SDK console tutorial](docs/tutorials/phase-05-sdk-console.md)
- [Phase 5 browser SDK reference](docs/phase-05-sdk.md)
- [Phase 5 component decision record](docs/design/phase-5-component-decisions.md)
- [Phase 7 semantic catalog and authorization](docs/phase-07-semantic-catalog.md)
- [Phase 7 live runnerd and Codex loop](docs/phase-07-live-runnerd-codex.md)
- [PRP compatibility/versioning policy](docs/protocol-compatibility.md)
- [Cumulative end-to-end tutorial](docs/tutorials/end-to-end.md)
- [Journal guide](docs/journal.md)
- [OKF knowledge bundle](knowledge/)
- [Implementation plan](spec/paperclip-native-runner-implementation-plan.md)
- [Normative spike specification](spec/paperclip-native-runner-spike-spec.md)

Phase 4 adds the package-local real-model reference driver, Phase 4b adds the
package-local browser console, and Phase 5 extracts a reusable public SDK plus
two standalone consumers. Production Paperclip integration remains deferred.
