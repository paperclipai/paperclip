# Native Runner Tutorials

The tutorials are cumulative and are always run from the repository root.
Each tutorial explains the capability it exercises and the contract it proves.

## Implemented capabilities

- [Conformance: standalone tracer](tutorials/conformance-standalone-tracer.md) — install the workspace, validate its Rust/TypeScript boundary and knowledge bundle, then run the deterministic Rust mock-core path and cross-language parity check.
- [Replay: static PRP replay](tutorials/replay.md) — validate the shared schema/fixture corpus, reduce a fixture in the CLI, and inspect the same final snapshot in the standalone browser page.
- [Local runner: local runner and fake harness](tutorials/local-runner.md) — run a supervised Rust process, exercise scripted live scenarios, resolve requests, interrupt a turn, and confirm live/replay parity.
- [Durable recovery: break recovery on purpose](tutorials/durable-recovery.md) — lose an ACK, drop the socket, restart the runner side, replay durable events, and inspect recovery diagnostics.
- [Codex: run the skillless Codex driver](tutorials/codex.md) — run a safe real-model task, inspect the exact context boundary, steer or interrupt it, and confirm one replay-safe result.
- [Live console: run the protocol demo server](tutorials/live-console-protocol-server.md) — exercise the server-only Codex boundary, canonical replay, typed controls, and reconnect with `curl`.
- [Live console: run the live Codex protocol console](tutorials/live-console.md) — chat with a live session in the browser, steer it, stop it three ways, answer its requests, change its goal, break its connection, and replay the record.
- [SDK: run the SDK console and mini consumer](tutorials/sdk-console.md) — exercise the versioned public browser/React surface in two independent consumers against fake and real drivers.
- [Standalone: run the thin Paperclip adapter](tutorials/standalone-thin-paperclip-adapter.md) — prove mock/real conformance, run one feature-flagged local task, inspect replay/finalization, disable the kill switch, and verify legacy fallback.
- [Capability: the Paperclip-style issue thread over a mock control plane](tutorials/capability-issue-thread.md) — the canonical clean-start tutorial for the final build: prove the 106-case conformance suite, open the issue thread in deterministic fake mode, record the byte-stable screenshot matrix, and optionally drive a real Codex turn — all from a clean checkout with no Paperclip service.
- [Capability: explore the capability contract and scenario explorer](tutorials/capability-scenario-explorer.md) — companion tour of the read-only browser explorer over the mock control plane and the focused verification set.
- [Scenario chat: chat with the mock control plane](tutorials/scenario-chat.md) — the scenario-explorer chat surface: send prompts to a Capability scenario and watch the mock Paperclip activity for every turn: exposure, typed calls, denials, control-plane-owned actions, state diffs, wakes, and per-turn parity.
- [Capability: chat with real Codex in a clean room](tutorials/capability-clean-room-chat.md) — the second primary path: open a blank chat on a freshly minted mock tenant, send a free-form message to real Codex through real runnerd, and inspect the tool, policy, and state evidence on demand.
- [Cumulative end-to-end tutorial](tutorials/end-to-end.md) — the shortest complete workflow for the current package.

## Reference

- [Architecture and dependency boundary](architecture.md)
- [Paperclip Evals integration contract](evals-integration.md)
- [PRP compatibility and versioning policy](protocol-compatibility.md)
- [PRP v1 expressiveness audit](../spec/prp-v1-expressiveness-audit.md)
- [ADR 0001: runner, testing, and eval package boundaries](adr/0001-runner-testing-eval-package-boundaries.md)
- [Local protocol and supervision](local-runner.md)
- [Durable transport and recovery](durable-recovery.md)
- [Codex skillless Codex driver](codex-driver.md)
- [Live console protocol and demo server](live-console-protocol-server.md)
- [Live console](live-console.md)
- [SDK browser SDK and reference console](sdk.md)
- [Standalone thin Paperclip adapter](standalone-thin-paperclip-adapter.md)
- [Capability contract (generated)](capability-contract.md)
- [Capability disposition](capability-disposition.md)
- [Capability mock ControlPlanePort](capability-mock-control-plane-port.md)
- [Capability semantic catalog and authorization](capability-semantic-catalog.md)
- [Capability semantic tool catalog](capability-semantic-tools.md)
- [Capability authorization and exposure](capability-authorization-and-exposure.md)
- [Capability eval-derived conformance](capability-eval-conformance.md)
- [Runner eval vertical slice (bundle + scoring)](capability-eval-slice.md)
- [Capability browser scenario explorer](capability-scenario-explorer.md)
- [Capability live runnerd/Codex loop](capability-live-runnerd-codex.md)
- [Capability execution modes and identity (fake vs real Codex)](capability-execution-modes.md)
- [Capability Paperclip-style issue-thread UI](capability-issue-thread-ui.md)
- [Capability clean-room live chat](capability-clean-room-chat.md)
- [Scenario chat interactive scenario chat](scenario-chat.md)
- [Capability future binding boundary (future upload integration / ACPX)](capability-future-binding-boundary.md)
- [Capability verification commands](capability-verification-commands.md)
- [Capability scenario explorer UX interaction map](design/capability-scenario-explorer-ux.md)
- [Scenario chat mobile chat UX interaction map](design/scenario-chat-ux.md)
- [Dated shadcn/ui and AI Elements compatibility note](research/2026-08-07-ui-library-compatibility.md)
- [Live console live-console interaction map](design/live-console-interaction-map.md)
- [Live console component decision record (shadcn/ui, AI Elements)](design/live-console-component-decisions.md)
- [SDK extraction decision record](design/sdk-component-decisions.md)
- [Standalone thin Paperclip adapter boundary](design/standalone-thin-paperclip-adapter.md)
- [Package README](../README.md)

Standalone is implemented as a default-off server integration at the public
package boundary. Production Paperclip UI integration remains deferred.
