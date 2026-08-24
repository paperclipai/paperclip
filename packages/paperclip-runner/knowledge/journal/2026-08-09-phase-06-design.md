---
type: Engineering Journal Entry
title: Phase 6 thin Paperclip adapter design
description: Decision-ready boundary, rollout, threat model, conformance matrix, and tutorial contract for the first Paperclip integration tracer.
tags: [native-runner, phase-6, architecture, integration, security, replay, feature-flag]
status: draft
generated: { by: openai/codex-local, at: 2026-08-09T03:00:00Z }
entry_kind: phase
phase: "6"
---

# Context

Phases 0-5 proved the package in isolation. Phase 6 is the first permitted
Paperclip control-plane integration. The design must preserve the package
boundary and every current control-plane authority while enabling one useful,
reversible tracer.

# Decisions

1. Paperclip depends only on the public `ControlPlanePort` and
   `NativeSessionBackend`; concrete drivers and session loops remain packaged.
2. The single core branch occurs after existing environment/workspace
   realization and before legacy `adapter.execute`. Existing preparation and
   finalization remain in place.
3. A default-off instance flag plus a company-scoped per-agent profile selects
   native mode. The resolved mode is persisted and never changes mid-run.
4. Disabling the instance flag is the new-run kill switch. A selected native
   run fails or recovers as native and never silently retries through legacy.
5. Native events extend the existing heartbeat event timeline with nullable
   source identity, sequence, digest, and schema fields. All writers share a
   per-run transactional allocator backed by `heartbeat_runs.next_event_seq`
   and unique `(run_id, seq)`; acknowledgement occurs only after commit.
6. First-class `heartbeat_runs.runtime_mode` fields, `native_run_results`, and
   `native_run_finalizations` make selection and terminal recovery independent
   of the current flag, agent profile, or producer process.
7. Runner/model data has no company, approval, interaction, budget, or issue-
   status authority. A strict native input allowlist excludes local JWT/API
   keys, managed MCP credentials, wake/skill context, raw env, and every other
   legacy-only execution field.
8. The additive native finalizer applies the complete Section 18 contract:
   immutable contract/result/assessment, evidence classification, pure arbiter,
   CAS status/effect commit, native interaction bridge, and reconciliation.
   Shadow comparison is only MIG-04/MIG-05; Phase 6 proves MIG-06 application.
9. A package-exported conformance suite runs unchanged against the mock and
   database-backed real ports. Real Codex is a smoke proof, not the deterministic
   authority.
10. No browser UI is required. A later native-status UI needs a separate UX
   review before implementation.

The complete decision record is
[Phase 6 Thin Paperclip Adapter Boundary](../../docs/design/phase-6-thin-paperclip-adapter.md).

# Evidence

- Read the accepted package contracts, PRP schemas, Phase 0-5 architecture,
  implementation plan, and normative native-finalization/status-authority
  sections.
- Traced the current heartbeat execution sequence through workspace
  realization, adapter invocation, workspace-finalize barrier, terminal write,
  liveness handling, cancellation, budget cancellation, and resource release.
- Confirmed `heartbeat_run_events` is the existing company/run-scoped operator
  timeline and identified the missing source identity/dedup columns required for
  durable PRP acknowledgement and replay.
- Recorded the revised storage/finalizer file allowlist, 32-case test matrix,
  allocator/credential/recovery commands,
  legacy fallback proof, and tutorial outline in package-local documentation.
- Design-only verification command:
  `pnpm --filter @paperclipai/paperclip-runner docs:validate`.

# Failures

No implementation was attempted. The design discovery found two contract gaps
that implementation must resolve explicitly rather than hide:

- the original `ControlPlanePort` still consumes the narrow Phase 0 event
  sketch instead of the accepted PRP event/result types;
- the current cancellation registry only knows process-backed legacy adapters
  and needs a run-scoped native cancel handle.

# Known gaps

- The Phase 6 tracer does not expose a public runner WebSocket.
- It supports only an issue-bound local `codex_local` native profile.
- It materializes only strictly typed supported interaction requests through
  existing governance services and cannot approve governance actions.
- It applies only server-owned Section 18 decisions; model-reported issue
  status remains advisory.
- Exact API request examples for toggling the flag depend on the local instance
  auth mode and will be filled in after implementation proves both modes.

# Follow-up questions

- CTO: approve extending `heartbeat_run_events` with the shared per-run
  allocator, or require a dedicated native event table now?
- CTO: approve the restored complete Section 18 finalization/arbitration scope,
  with shadow comparison only as its MIG-04/MIG-05 rollout stage?
- Security: is the in-process, server-bound port sufficient for Phase 6 before
  a one-time runner lease and outbound WebSocket are introduced?

# Revision verification

Self-review against the design-revision gate completed on 2026-08-09:

- restored typed native finalization and complete Section 18 server-owned
  arbitration; shadow comparison is only MIG-04/MIG-05 and the Phase 6 proof
  proceeds through the MIG-06 internal canary;
- named every first-class run-mode, contract, result, coordinator, assessment,
  decision, effect, issue-version, and event-sequence field plus restart/flag-
  off/process-loss recovery reads and canonical byte-equivalence rules;
- replaced source-dedup-only ordering with the shared row-locked per-run
  allocator, unique `(run_id, seq)`, deterministic migration repair/backfill,
  and concurrent lifecycle/cancel/native/log cases;
- replaced generic legacy context handoff with strict native/package/model
  allowlists and explicit negative coverage for JWT/API/MCP credentials,
  wake/skill content, raw env, and legacy-only context;
- revised the file allowlist, implementation order, 32-case matrix, runnable
  commands, tutorial, and evidence artifact plan;
- confirmed documentation-only scope with `git diff --check`; no implementation
  source was added by this revision.

Required validation passed:

```text
pnpm --filter @paperclipai/paperclip-runner docs:validate
Documentation link validation passed (55 files).
OKF v0.2 validation passed (23 concepts, 4 indexes).
```
