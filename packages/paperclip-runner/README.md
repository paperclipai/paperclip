# Paperclip Native Runner

This package is the standalone development boundary for Paperclip's native
runner protocol, process supervision, durable transport, provider drivers, and
normalized session backends. Rust owns the production runner under `runner/`;
TypeScript provides the control-plane reference, browser SDK, scenario tools,
and conformance oracle.

The package includes one coherent set of capabilities: PRP v1 validation and
replay, a supervised local runner with a scripted fake harness, durable
WebSocket delivery and recovery, a skillless Codex app-server driver, live
session and issue-thread surfaces, a public browser/React SDK, a standalone
adapter demo, and a deterministic mock control plane. None of these surfaces
imports or starts Paperclip's server, UI, CLI, or production database.

## Public package surfaces

- `@paperclipai/paperclip-runner` — production contracts, clients/backends,
  PRP validation/replay, canonical catalog/dispatcher, and compatibility check.
- `@paperclipai/paperclip-runner/evals` — versioned native-attempt/build
  metadata, explicit digest-verified runnerd artifact resolution, and complete
  App/Evals compatibility negotiation.
- `@paperclipai/paperclip-runner/testing` — deterministic mocks plus PRP and
  semantic conformance kits. Tests and Paperclip Evals import this explicitly.
- `@paperclipai/paperclip-eval-kernel` — separately packed generic eval matrix
  orchestration, permitted in Paperclip App only as a development dependency.

The package root has no mock or scenario exports, and no Paperclip Evals runtime
dependency. See [ADR 0001](docs/adr/0001-runner-testing-eval-package-boundaries.md).

The two conformance surfaces intentionally prove different contracts. The
existing `runControlPlanePortConformance` suite checks narrow PRP run/event
persistence. `CAPABILITY_HIGH_RISK_SEMANTIC_VECTORS` and
`runSemanticConformanceKit` compare normalized tool authorization, state,
effects, audit, retries, conflicts, redaction, continuation, and terminal
decisions. The production adapter stays App-owned and invokes Paperclip's real
route/service authorities; it does not copy those rules into this package.

## Quick start

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
{"schemaVersion":"paperclip.runner.conformance.output.v1","runIdentity":{"runId":"run_conformance_0001","sessionId":"session_conformance_0001"},"result":{"status":"succeeded","summary":"Standalone Conformance fixture accepted."}}
```

Run only the tracer with:

```sh
pnpm --filter @paperclipai/paperclip-runner trace:conformance
```

Replay the Replay happy path, run a Local session, or open the browser
devtool:

```sh
pnpm --filter @paperclipai/paperclip-runner replay:fixture
pnpm --filter @paperclipai/paperclip-runner trace:local-runner -- --scenario happy-path
pnpm --filter @paperclipai/paperclip-runner trace:durable-recovery -- --fault lost-ack
pnpm --filter @paperclipai/paperclip-runner trace:codex
pnpm --filter @paperclipai/paperclip-runner demo:live-console -- --host 127.0.0.1 --port 4174

# Live console: chat with a live session in the browser.
pnpm --filter @paperclipai/paperclip-runner console:live-console
pnpm --filter @paperclipai/paperclip-runner browser:dev --host 127.0.0.1 --port 4179

# SDK: open the public-SDK reference console and mini consumer.
pnpm --filter @paperclipai/paperclip-runner console:sdk

# Standalone: run the standalone legacy/native/kill-switch tracer and page.
pnpm --filter @paperclipai/paperclip-runner trace:standalone
pnpm --filter @paperclipai/paperclip-runner trace:standalone -- --feature-flag enabled
pnpm --filter @paperclipai/paperclip-runner trace:standalone -- --feature-flag enabled --kill-switch enabled
pnpm --filter @paperclipai/paperclip-runner demo:standalone

```

Live console provider-backed routes are loopback-only and reject wildcard/LAN
binds. Browser mutations require same-origin Fetch Metadata, matching Origin,
and JSON content; see the protocol-server tutorial for direct `curl` examples.

## Package-owned commands

| Command | Purpose |
|---|---|
| `build` | Compile the TypeScript public surface, Rust workspace, and browser devtool. |
| `typecheck` | Check TypeScript, Rust, generated schema sources, and browser types. |
| `test` | Run Rust/TypeScript fixture, supervisor, fake-driver, live/replay, and boundary tests. |
| `check:forbidden-imports` | Reject TypeScript imports and Cargo path dependencies that cross into Paperclip core. |
| `check:tracked-imports` | Reject tracked imports and `package.json` entry points that only resolve against untracked files, so a clean checkout of any commit builds. |
| `check:numbered-milestones` | Reject numbered construction-milestone names in tracked package paths and source. |
| `check:package-boundaries` | Enforce the acyclic runtime/testing/eval dependency and manifest boundary. |
| `check:clean-consumers` | Pack runner and eval-kernel tarballs and install them in two clean consumers. |
| `check:conformance-parity` | Require byte-for-byte equivalent Rust and TypeScript tracer output. |
| `check:replay-goldens` | Require all reducer snapshots and cross-language summaries to match checked goldens. |
| `check:replay-parity` | Run TypeScript and Rust against the same Replay fixture summaries. |
| `check:browser-tokens` | Reject component-local visual literals and require the standalone token layer. |
| `docs:validate` | Validate local documentation links and the OKF v0.2 bundle. |
| `trace:conformance` | Run the Rust mock-core tracer, print the stable result, and exit. |
| `trace:conformance:typescript` | Run the TypeScript reference tracer directly. |
| `replay:fixture` | Validate and reduce a fixture to a final snapshot. |
| `trace:local-runner` | Run one native local session through the Rust runner and fake harness. |
| `record:local-runner` | Capture a validated happy-path live trace as a replay fixture. |
| `trace:durable-recovery` | Run the Rust runner against the mock core with a selected recovery fault. |
| `record:durable-recovery` | Regenerate the complete Durable recovery fault matrix and exact per-fault traces. |
| `trace:codex` | Run the mock core with a real, local skillless Codex app-server session. |
| `record:codex` | Run the safe Codex task and record its validated, normalized trace. |
| `demo:live-console` | Start the package-local HTTP/SSE server with server-only Codex authentication. |
| `console:live-console` | Start the standalone browser devtool with the Live console on `127.0.0.1:4180`. |
| `record:live-console` | Run a safe real Codex task through the demo server and record reconnect/replay evidence. |
| `console:sdk` | Start the public-SDK reference console and mini consumer on `127.0.0.1:4181`. |
| `test:sdk` | Run targeted browser-client, reducer-projection, and React component contract tests. |
| `test:browser:sdk` | Exercise both consumers with the fake driver, keyboard/a11y checks, reconnect/replay, measurements, and screenshots. |
| `record:sdk:codex` | Run both public consumers against a safe real Codex session and capture live screenshots. |
| `check:capability-contract` | Verify the generated capability, legacy MCP, and eval traceability contract. |
| `check:semantic-contracts` | Verify the provider-neutral semantic tool contract is current. |
| `trace:live-runner` | Run the real runnerd/Codex semantic loop against the mock control plane. |
| `demo:scenarios` | Start the Capability scenario explorer over the mock control plane on `127.0.0.1:4183`. |
| `console:issue-thread` | Start the Paperclip-style issue thread on `127.0.0.1:4184`. |
| `test:scenarios` | Run the scenario index, run-artifact, parity, explorer component, and route tests. |
| `test:browser:scenarios` | Exercise both the scenario explorer and issue-thread browser contracts. |
| `record:capability` | Record the twelve-route screenshot acceptance set at both viewports. |
| `browser:dev` | Start the standalone live/replay/recovery browser devtool. |
| `test:browser` | Exercise static replay and live scenarios, then capture temporary screenshots under ignored test output. |
| `verify` | Run the complete deterministic Conformance through SDK acceptance sequence. |
| `verify:rootless` | Extract Debian/Ubuntu browser libraries without root, then run `verify`. |

## Navigate

- [Architecture and dependency boundary](docs/architecture.md)
- [ADR 0001: runner, testing, and eval package boundaries](docs/adr/0001-runner-testing-eval-package-boundaries.md)
- [Tutorial index](docs/index.md)
- [Conformance hand-run tutorial](docs/tutorials/conformance-standalone-tracer.md)
- [Replay hand-run tutorial](docs/tutorials/replay.md)
- [Local runner hand-run tutorial](docs/tutorials/local-runner.md)
- [Local protocol reference](docs/local-runner.md)
- [Durable recovery break-it-on-purpose tutorial](docs/tutorials/durable-recovery.md)
- [Durable transport reference](docs/durable-recovery.md)
- [Codex skillless Codex tutorial](docs/tutorials/codex.md)
- [Codex skillless Codex driver reference](docs/codex-driver.md)
- [Live console protocol/server tutorial](docs/tutorials/live-console-protocol-server.md)
- [Live console protocol/server reference](docs/live-console-protocol-server.md)
- [Live console tutorial](docs/tutorials/live-console.md)
- [Live console reference](docs/live-console.md)
- [SDK console tutorial](docs/tutorials/sdk-console.md)
- [SDK browser SDK reference](docs/sdk.md)
- [SDK component decision record](docs/design/sdk-component-decisions.md)
- [Capability semantic catalog and authorization](docs/capability-semantic-catalog.md)
- [Capability live runnerd/Codex loop](docs/capability-live-runnerd-codex.md)
- [Capability issue-thread UI](docs/capability-issue-thread-ui.md)
- [PRP compatibility/versioning policy](docs/protocol-compatibility.md)
- [Paperclip Evals integration contract](docs/evals-integration.md)
- [PRP v1 expressiveness audit](spec/prp-v1-expressiveness-audit.md)
- [Cumulative end-to-end tutorial](docs/tutorials/end-to-end.md)
- [OKF knowledge bundle](knowledge/)
- [Normative native-runner contract](spec/native-runner-contract.md)

Codex adds the package-local real-model reference driver, Live console adds the
package-local browser console, and SDK extracts a reusable public SDK plus
two standalone consumers. Runtime production Paperclip integration remains
deferred; the App-owned production conformance adapter is test-only.

The SDK reference console opens in direct chat mode. Enter a normal prompt,
then open the protocol inspector to review events and reducer state. Expand a
Terminal row and its nested **Debug details** disclosure to inspect every
canonical event retained for that command. The header marker `🖇️ v0.1.2`
identifies the current console iteration.
