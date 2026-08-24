# Phase 6 Thin Paperclip Adapter

Phase 6 adds one production integration seam without moving runner behavior
into Paperclip core. Paperclip owns workspace lifecycle, company/auth scope,
budgets, approvals, audit, cancellation, durable persistence, and issue status.
The package owns normalized sessions, provider-driver construction, PRP event
production, and semantic result production.

## Selection and rollback

Native mode requires both `experimental.enableNativeRunner=true` and an
eligible agent profile:

```json
{
  "nativeRunner": {
    "mode": "native",
    "backend": "codex_app_server",
    "protocolVersion": 1
  }
}
```

Only active local `codex_local` agents running standard, workspace-backed
issues are eligible. The default and the kill switch are legacy. An explicit
but ineligible native profile fails closed; there is no same-run fallback.
Selection, resolver version/reason, profile, runner instance, and completion
contract are persisted before provider execution.

## Public boundary

`PaperclipControlPlanePort` implements the package's `ControlPlanePort`:

- `openRun` verifies company/run/issue/agent/contract binding;
- `loadSessionCheckpoint` and `checkpointSession` bind restart state to the
  same company/run/issue/agent/session identity;
- `appendEvent` validates PRP, commits through the shared per-run allocator,
  deduplicates source identity by canonical digest, and acknowledges afterward;
- `replayEvents` uses an exclusive source cursor;
- `completeRun` validates and idempotently persists the immutable structured
  result plus terminal fact.

The package-owned Codex native backend is the production
`NativeSessionBackend`; the harness backend remains the deterministic test
adapter. Core passes only the closed `NativeExecutionInputV1`.
The model receives the smaller `NativeModelEnvelopeV1`; bindings and credential
references do not cross that boundary.

## Persistence and authority

Migration 0211 adds immutable completion contracts/results/assessments,
restart-safe finalization coordinators, status decisions/effects, issue status
versions, native run metadata, and native source identity on heartbeat events.
All event writers allocate from the row-locked `heartbeat_runs.next_event_seq`.

Finalization runs only after result persistence and workspace finalization. The
server verifies cited evidence against company- and issue-scoped durable
events, work products, approvals, interactions, or attachments; model claims
alone cannot complete an issue. The pure arbiter marks `done` only when the
terminal state succeeded, every criterion and verification has accepted
durable evidence, and no blocking work remains. It marks `blocked` only for a
task-wide first-class blocker with a named owner and action. Review, retry,
continuation, blocker, and recovery effects materialize atomically with the
status-version CAS and audit record. The committer has no catch-all delivery:
all native effect kinds must create or mutate their named target, and unknown
effects fail the transaction closed.

## Recovery and safety

Recovery selects persisted `runtime_mode=native` coordinators and does not
consult the current flag. Result-less transport loss retains the original run,
closed native input, provider checkpoint, retry attempt, and recovery action;
a database lease dispatches that same run after restart. Missing checkpoints,
cancellation, and retry exhaustion fail closed without opening a new provider
session or falling into legacy. Result-bearing rows continue through the
workspace/finalization reconciler. A recovered package session inspects the
provider snapshot before starting a turn, so an active provider turn is not
duplicated. Cancellation uses a run-scoped normalized session handle before the
existing process cleanup. Native execution does not construct a Paperclip JWT,
managed MCP access, legacy context, or raw adapter environment.

Resolved `request_confirmation` and `ask_user_questions` wakes are projected
through the existing authorized issue-interaction service and bound to the
company, issue, run, agent, and interaction identities in the persisted input.
Governed tool actions, unsupported kinds, unresolved rows, and self-resolution
fail closed; no credentials enter the model envelope.

## Verification status

The deterministic package suite and the embedded-PostgreSQL Paperclip suite
prove selection, replay/conflict handling, authoritative evidence,
status/liveness atomicity, migration repair, bounded cancellation/retry, and a
byte-equivalent legacy read snapshot. The thirteen-file database gate contains
46 tests with zero skips. The database suite is the internal
native canary: it executes one selected task through the public package session
contract and applies one server-owned decision. Its post-kill-switch legacy
case has zero native history rows.

The Section 18.13 database test executes fixture-specific production consumers
for all 52 fixtures. It derives and checks all eleven expected fields from
consumer return values and persisted production rows: run status,
status/preserve action, reason, required and forbidden effects, live-path kind,
claim preservation, native-record behavior, decision count, maximum wake
count, and maximum notification count. Each of the 70 unique matrix rows names
the responsible finalizer, terminal projection, attention, cancellation,
committer, reconciliation, compatibility, or migration consumer and fails if
that consumer did not execute or returned different semantics. A per-fixture
mutation check independently changes every expected field and proves the
comparison rejects it; there is no test-owned policy table supplying observed
semantics. Finalizer observations come from the live fact-based arbiter rather
than a fixture-state switch. Every delivered effect is joined to an actual
persisted target, replay is required to retain the same decision with one
delivery attempt, and an unknown-effect test proves the transaction leaves no
decision, ledger, issue-version, or coordinator mutation.

Operational rows use the production call graph, not resolver calls as a proxy.
Cancellation is committed and audited by the normalized session cancellation
entrypoint. Accepted attention starts at the immutable package-result row:
`finalizeNativeRun` calls `routePersistedNativeResultAttention`, records a
request-specific assessment, and then delegates an eligible same-company
target through `issueService`, creates a human issue-thread interaction, or
persists a cross-company rejection decision/recovery/audit trail.
Duplicate and stale targets finish as committed audit-only coordinators with
zero decisions, wakes, notifications, or issue status/version changes. Their
run receipt names the exact interaction target, and replay neither adds an
assessment nor updates that interaction again. Missing and cross-company audit
targets fail closed. `routePersistedNativeResultAttention` and
`routeNativeAttention` are internal helpers, not operational test ingresses.
Reconciliation selects the persisted
status/evidence/policy branches and executes workspace recovery through the
workspace operation recorder. The rollout kill switch is only the global
`experimental.enableNativeRunner` flag. Persisted native runs keep their mode
and finish/reconcile natively after flag-off; fresh unresolved runs for the
same agent persist legacy mode with `instance_flag_disabled`. The opted-in
agent profile remains unchanged, so re-enabling the flag does not require a
profile reset. Pending replay
only acknowledges its original decision-scoped target after verifying that the
target still exists.

Direct resolver and persisted-router calls are explicitly policy/internal
helper tests. They do not
satisfy an operational fixture without a runtime-reachable entrypoint receipt
and concrete durable target. Sabotage removes the finalizer-owned accepted-
attention path for the duplicate and stale fixtures, changes the real global-
flag input, removes cancellation/reconciliation actions, and deletes a pending
replay target; mapped fixtures fail while their pure resolver labels remain
unchanged.

Result-less same-run recovery is also proven through the production heartbeat
seam: a persisted envelope/checkpoint is leased by `reapOrphanedRuns`, enters
the original `executeRun`, recovers an already-active provider turn, and reaches
one persisted result, assessment, decision/effect set, and terminal heartbeat
projection. The test runs with the native flag disabled and asserts one run,
no new provider session or turn, no legacy adapter execution, lease-race
exclusion, cancellation/exhaustion exclusion, and missing-checkpoint
fail-closed behavior. The provider itself is scripted; this is not live Codex
evidence.

No new live provider task was dispatched during the remediation review. A live
Codex canary remains an operator-run rollout check because it requires changing
the instance flag and one agent profile. The package `trace:phase6` command is a
mock contract tracer; real Paperclip proof is the database-backed server matrix
and the explicitly gated procedure in the tutorial.

Deferred boundaries are unchanged: there is no attention UI or public
attention API, no external-system action execution, no credential delegation,
and no auto-approval. The Codex v1 structured-output schema authors compact
`kind`/`summary` attention requests; richer canonical PRP target metadata is
accepted and company-validated at the server boundary but does not yet have
provider authoring UX.

See the [runnable tutorial](tutorials/phase-06-thin-paperclip-adapter.md), the
[verification record](../knowledge/evidence/2026-08-09-phase-06-verification.md),
and the [approved design](design/phase-6-thin-paperclip-adapter.md).
