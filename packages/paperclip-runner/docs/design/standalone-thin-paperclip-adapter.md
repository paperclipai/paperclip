# Standalone Thin Paperclip Adapter Boundary

> **Scope correction — 2026-08-09:** The board superseded real Paperclip
> installation and live-instance execution for the current checkpoint. Active
> Standalone work is limited to the standalone demo runner and demo page under
> `packages/paperclip-runner/`. Product/server/database sections below are
> retained as historical design context, not current execution instructions.

Status: design approved; remediation 8 documentation reconciliation complete; final CTO gate pending
Date: 2026-08-09
Decision scope: the first feature-flagged Paperclip native run, including the
normative native finalizer and server-owned Section 18 status arbitration

## Decision

Paperclip will integrate the native runner through two public package ports:

- `NativeSessionBackend` owns a normalized native session and hides the
  package's concrete `HarnessDriver` and Codex implementation.
- `ControlPlanePort` accepts validated PRP events and terminal results from the
  package and exposes durable acknowledgement and replay cursors.

The two ports are complementary, not two core implementations. The runner
package supplies the `NativeSessionBackend` implementation; Paperclip supplies
the server-bound `ControlPlanePort` implementation. The core adapter only
composes those public contracts and translates the final result into existing
Paperclip types. It does not implement a native backend or contain runner
behavior.

The dependency direction is one way:

```text
server heartbeat orchestration
  -> PaperclipNativeRuntimeAdapter (core seam)
      -> @paperclipai/paperclip-runner public contracts
          -> NativeSessionBackend -> package-owned driver/runner logic
          -> ControlPlanePort      -> server-bound Paperclip implementation
```

`packages/paperclip-runner/` never imports `server/`, `packages/db/`,
`packages/shared/`, or a Paperclip service. The server may import the public
package. The core seam may translate company-scoped Paperclip records into the
public input types, persist protocol records, and convert one terminal native
result into the existing `AdapterExecutionResult`. It must not contain driver,
provider, reducer, outbox, reconnect, or process-supervision logic.

This remains a narrow, default-off tracer: it does not enable native execution
by default, migrate legacy runs, or add browser UI. “Thin” limits where runner
behavior lives; it does not remove the normative completion contract. Standalone
is complete only when the additive native finalizer applies the complete
Section 18 arbitration contract required by the spike exit criteria and NR-006.

## Why the current sketches need one package-local reconciliation

The original `ControlPlanePort` and `NativeRunEvent` sketch proves the Conformance
lifecycle, while the accepted Replay-5 path uses `PrpEvent`,
`PrpStructuredRunResult`, durable source sequences, and replay. Before the real
adapter is added, the package contract must be reconciled without importing
Paperclip types:

```ts
interface ControlPlanePort {
  openRun(input: OpenControlPlaneRunInput): Promise<void>;
  appendEvent(event: PrpEvent): Promise<{
    highestContiguousSourceSeq: number;
    disposition: "committed" | "duplicate";
  }>;
  replayEvents(input: {
    runId: string;
    sourceInstanceId: string;
    afterSourceSeq: number;
    limit: number;
  }): Promise<{
    events: PrpEvent[];
    highestContiguousSourceSeq: number;
  }>;
  completeRun(input: {
    result: PrpStructuredRunResult;
    terminal: PrpTerminalState;
  }): Promise<void>;
}
```

The exact exported names may stay source-compatible through overloads, but the
observable contract above is required. The Conformance fixture may be adapted
inside the package; no production adapter may invent a second event type.

`NativeSessionBackend` remains the control-plane-facing session contract. A
package-local backend adapts `HarnessDriver`/`HarnessSession` into it, including
the accepted semantic result stored in the harness snapshot. Paperclip core
must not construct `CodexAppServerDriver` or inspect provider notifications.

## Core branch point

The sole execution branch belongs in `server/src/services/heartbeat.ts` after
the existing environment lease and workspace realization have succeeded and
immediately before `adapter.execute(...)` today:

```ts
const mode = resolveNativeRuntimeMode({ settings, agent, run, issue, target });
await persistResolvedNativeRunEnvelope({ run, issue, mode, contract, target });

const adapterResult = mode.kind === "native"
  ? await nativeSessionRuntime.execute(
      buildNativeExecutionInput({ run, issue, mode, contract, target, session }),
    )
  : await adapter.execute(existingLegacyExecutionContext);
```

Everything before the branch remains Paperclip-owned preparation. Shared
cleanup after either branch still owns usage/cost accounting, session and agent
state, audit/live events, environment lease release, runtime service release,
and scratch cleanup. Native mode replaces only the legacy terminal heuristic:
after the existing `workspace_finalize` barrier, `NativeRunFinalizer` preserves
the typed result, classifies evidence, builds an immutable assessment, calls
the pure `StatusArbiter`, and commits the run/issue/liveness effects atomically.
Legacy mode retains the current finalizer byte-for-byte.

The native adapter returns through `AdapterExecutionResult` with an additive,
strictly validated `nativeFinalization` discriminator. Existing adapters omit
that field. Native run terminal state is taken only from the persisted run
profile plus that typed discriminator; exit code and model-authored fields in
`resultJson` are diagnostics and are never native fallback heuristics.

## Durable native run envelope and recovery boundary

Standalone uses first-class columns and the Section 18 tables, not keys hidden in
`context_snapshot` or `result_json`.

`heartbeat_runs` gains these exact fields:

```text
runtime_mode                 text not null default 'legacy'
runtime_mode_resolver_version text null
runtime_mode_reason          text null
runtime_mode_resolved_at     timestamptz null
runner_profile_json          jsonb null        -- redacted resolved snapshot
runner_instance_id           uuid null
native_session_id            uuid null
driver_kind                  text null
driver_version               text null
completion_contract_id       uuid null references completion_contracts
completion_contract_sha256   text null
next_event_seq               bigint not null default 1
native_phase                 text null
native_phase_updated_at      timestamptz null
```

The selection transaction locks the run row and writes `runtime_mode`, the
resolver version/reason/timestamp, redacted profile, realized target identity,
and the immutable completion-contract reference before any native provider, runner,
or harness invocation. `runtime_mode='native'` without a valid contract/profile
is a fail-closed native setup/finalization error; it never means legacy.

Terminal claims are stored in the normative append-only
`native_run_results` table (`company_id`, `issue_id`, `run_id`, `turn_id`,
`completion_contract_id`, caller IDs, `server_fingerprint`, `schema_status`,
`rejection_code`, the safe original `result_json`, and `canonical_sha256`). One
row-locked `native_run_finalizations` coordinator per run records `phase`,
`attempt`, lease, `result_id`, `assessment_id`, `decision_id`, and redacted
failure/retry fields. Receipt of a terminal result is acknowledged only after
the result row and coordinator `result_id` commit.

The rest of the finalization storage uses the exact Section 18.7 field sets:

| Durable record | Exact fields added/used |
|---|---|
| `completion_contracts` | `id`, `company_id`, `issue_id`, `revision`, `schema_version`, `policy_version`, `risk`, `completion_authority`, `incomplete_criteria_policy`, `contract_json`, `canonical_sha256`, `created_by_actor_type`, `created_by_actor_id`, `created_at`, `supersedes_contract_id` |
| `native_run_results` | `id`, `company_id`, `issue_id`, `run_id`, `turn_id`, `completion_contract_id`, `caller_result_id`, `caller_dedupe_key`, `server_fingerprint`, `schema_status`, `rejection_code`, `result_json`, `canonical_sha256`, `created_at` |
| `native_run_finalizations` | `run_id`, `company_id`, `issue_id`, `phase`, `attempt`, `lease_owner`, `lease_expires_at`, `result_id`, `assessment_id`, `decision_id`, `failure_code`, `failure_detail`, `next_attempt_at`, `created_at`, `updated_at` |
| `work_assessments` | `id`, `company_id`, `issue_id`, `run_id`, `turn_id`, `contract_id`, `result_id`, `trigger_kind`, `trigger_ref`, `trigger_capability`, `trigger_actor_company_id`, `prior_issue_status`, `prior_status_version`, `prior_decision_id`, `policy_version`, `assessment_json`, `input_digest`, `supersedes_assessment_id`, `created_at` |
| `status_decisions` | `id`, `company_id`, `issue_id`, `assessment_id`, `decision_version`, `policy_version`, `from_status`, `to_status`, `reason_code`, `decision_json`, `decision_digest`, `application_state`, `supersedes_decision_id`, `applied_at`, `created_at` |
| `status_decision_effects` | `id`, `company_id`, `issue_id`, `decision_id`, `ordinal`, `effect_kind`, `target_type`, `target_id`, `idempotency_key`, `payload`, `delivery_state`, `attempt_count`, `next_attempt_at`, `last_error`, `delivered_at`, `created_at`, `updated_at` |
| `issues` | new `status_version bigint not null default 0` and `last_status_decision_id uuid null`; existing status/liveness/lock fields remain projections |

Their unique keys, company foreign keys, immutable/supersession rules, and
effect-ledger semantics are unchanged from Section 18.7. `heartbeat_runs` also
gets only a compact result/finalization read projection in `result_json`; that
JSON is never the source of truth.

Byte equivalence means equality after the Section 18.8 canonical serializer:
UTF-8 JSON, recursively sorted object keys, protocol-order arrays, UTC RFC 3339
timestamps with millisecond precision, lowercase UUIDs, absent optionals
omitted, and bounded numeric serialization. Prose is preserved byte-for-byte
after schema normalization with no locale/Unicode compatibility folding. The
hashed material includes the complete validated envelope and server-bound
run/session/turn/contract identity, but excludes transport-only delivery
metadata. The server stores SHA-256 of those bytes. Reusing a source
event ID, source sequence, caller result ID, or caller dedupe key with another
hash is a replay conflict with no acknowledgement or effects. Equivalent
retries, including fresh caller keys with the same server fingerprint, return
the already committed canonical row and cursor.

Recovery never re-runs the resolver. Startup and periodic reconciliation read
`heartbeat_runs.runtime_mode`; for native rows they follow
`native_run_finalizations.result_id` to `native_run_results` and resume the
first missing durable phase. This remains true when the instance flag or agent
profile has since been disabled, the server restarted, or the runner process
disconnected. A disabled flag affects only runs whose mode has not yet been
resolved (`runtime_mode_resolved_at is null`).

## Feature flag, selection, and kill switch

The global gate is `instance.experimental.enableNativeRunner`, default `false`.
It is server/API configurable in the first slice; there is no UI control. The
per-agent opt-in is stored in the existing company-scoped
`agents.runtime_config` JSON:

```json
{
  "nativeRunner": {
    "mode": "native",
    "backend": "codex_app_server",
    "protocolVersion": 1
  }
}
```

The resolver is pure and versioned. Its inputs are the instance flag, the
persisted agent profile, the authenticated run/agent/issue records, and the
realized execution target. It does not read model output or PRP events.

| Global flag | Agent profile | Eligibility | New run mode |
|---|---|---|---|
| off | any | any | legacy |
| on | absent or `legacy` | any | legacy |
| on | `native` | eligible | native |
| on | `native` | ineligible before selection | rejected before invocation |

Initial eligibility is intentionally narrow: an issue-bound standard run, a
same-company active `codex_local` agent, protocol version 1, and a local
execution target with an already-realized workspace. Remote environments,
unscoped timer wakes, skill tests, task bridges, low-trust review, and other
drivers remain legacy or are rejected when explicitly misconfigured as native.

The resolved mode, resolver version, and non-secret reason code are persisted
on the heartbeat run before invocation. An active run never changes modes.

Turning `enableNativeRunner` off is the kill switch:

- queued and future runs resolve to legacy;
- an already-selected native run remains native until terminal, drained, or
  cancelled through the existing run-cancellation path;
- replays and recovery use the persisted mode even while the flag is off;
- no native error may retry the same run through `adapter.execute`.

This gives rollback without dual execution or ambiguous event history.

## Company, authentication, and threat boundary

The real `ControlPlanePort` is constructed inside the server with a bound
`companyId`, `runId`, `issueId`, `agentId`, and `sourceInstanceId` loaded from
authoritative rows. Every method compares incoming identity fields with that
binding and rejects generically before persistence on any mismatch.

The native branch does not spread or pass the legacy `context`, `runtimeConfig`,
`AdapterInvocationMeta`, or `process.env`. `buildNativeExecutionInput` is the
only constructor and returns this closed, strict schema (`unknown` keys are
rejected at the server/package boundary):

```ts
interface NativeExecutionInputV1 {
  schema: "paperclip.native-execution-input.v1";
  binding: {
    companyId: string;
    runId: string;
    issueId: string;
    agentId: string;
    executionWorkspaceId: string;
  };
  task: {
    identifier: string;
    title: string;
    description: string | null;
    workMode: "standard";
  };
  workspace: {
    cwd: string;
    repoUrl: string | null;
    repoRef: string | null;
    branchName: string | null;
  };
  session: {
    normalizedSessionId: string | null;
    driverKind: "codex_app_server";
    protocolVersion: 1;
  };
  completionContract: {
    id: string;
    sha256: string;
    schemaVersion: string;
    contract: StrictCompletionContractInput;
  };
  interactionResponses: NativeInteractionResponseEnvelope[];
  credentialBindings: NativeCredentialBindingRef[];
}
```

`credentialBindings` contains only opaque binding IDs, service/destination
policy, expiry, and non-secret display metadata. A broker or trusted launch
boundary may resolve a binding outside the model process; neither gateway
tokens nor secret values are fields in this input. Likewise, interaction
responses are the typed, destination-bound response envelopes from the native
interaction bridge, not a wake payload.

The package then builds a still smaller `NativeModelEnvelopeV1` from only
`task`, the safe workspace location, the completion schema, and applicable
typed interaction responses. Binding IDs, credential binding refs, runner
profile, and driver/session control data stay outside model-visible content.
There is no escape hatch such as `extra`, `metadata`, arbitrary `context`, or
arbitrary `env` in either schema.

The runner, package driver, and model/harness never receive:

- the local agent JWT, `PAPERCLIP_API_KEY`, a board session, or a board API key;
- managed MCP gateway credentials, runner-lease/bootstrap credentials, or
  credential-broker secret material;
- `PAPERCLIP_WAKE_PAYLOAD_JSON`, rendered Paperclip wake text, Paperclip skill
  instructions, the Paperclip API manual, or run-scoped skill material;
- raw `process.env`, agent/project/routine env maps, `runtimeConfig.env`, or the
  legacy adapter's generic execution context;
- authority to choose a company, issue, agent, policy, approval, or status;
- database access or a public issue-mutation endpoint;
- resolved secret values in events, snapshots, diagnostics, or digests.

The native constructor never reads the already-built legacy wake/context
object, and the native branch occurs before local-agent JWT construction,
managed-MCP gateway materialization, and legacy adapter invocation. Tests seed
unique canaries into every forbidden source, recursively
inspect the backend launch input and captured model request, and assert that no
key, value, serialized canary, or object reference crosses the native boundary.

The server-side port is an in-process capability for the first tracer. A future
runner WebSocket must authenticate a one-time runner lease and bind to the same
server-owned values; that transport is not part of this issue.

Threats and required responses:

| Threat | Required response |
|---|---|
| Event names another company/run/session | Generic rejection, no lookup disclosure, no write |
| Same source ID or sequence with different bytes | `native_event_replay_conflict`; fail native run closed |
| Caller supplies status, approval, or policy outcome | Preserve as untrusted payload at most; never apply |
| Event/result contains a known credential | Redact before diagnostics and reject persistence of the unsafe payload |
| Legacy context or raw env reaches native constructor | Validation/test failure before provider invocation |
| Native port or event store is unavailable | Do not acknowledge; runner keeps its durable outbox; fail/recover without legacy fallback |
| Flag is disabled after a run started | Finish/cancel the persisted native mode; never splice legacy execution into it |

## Governance and status authority

PRP events and `reportedWorkDisposition` are reports, not organizational
commands. The Standalone tracer does not add a runner-accessible issue status API.

- Existing board/user issue routes remain authorized organizational command
  paths. For native finalization, `StatusDecisionCommitter` is the only
  server-internal status writer and it applies only a `StatusArbiter` decision.
- Existing execution-policy participants remain the only execution-decision
  authority.
- Existing approval and interaction services remain the only materialization
  and decision paths. A native request cannot approve itself or translate an
  interaction into a formal approval.
- Existing budget checks decide whether dispatch is allowed and existing
  budget hard-stop cancellation remains authoritative.
- Existing activity logging records flag changes, runtime selection, run
  terminal state, cancellation, and any later governed mutation.

The native result and reported disposition are preserved as claims. The
additive native finalizer then applies the complete normative Section 18 flow:
immutable `CompletionContractService` revision, authenticated
`NativeResultIngestor`, exactly-once workspace finalization,
`EvidenceClassifier`, immutable `WorkAssessmentService` snapshot, pure
versioned `StatusArbiter`, serialized `StatusDecisionCommitter`, durable effect
ledger, and `NativeFinalizationReconciler`.

Shadow computation remains mandatory at MIG-04/MIG-05, but it is a rollout
stage, not the Standalone scope or exit state. Standalone evidence must proceed through
MIG-06 for one allowlisted internal company/agent and prove an applied decision.
Rollout can then be disabled again; already-selected native rows still reconcile
as native. If the complete corpus or application gate cannot pass, Standalone stays
blocked rather than shipping a contradictory shadow-only substitute.

The arbiter may choose `done`, `in_review`, `blocked`, continued `in_progress`,
or preserve-on-finalization-failure. Non-terminal decisions atomically create
the named reviewer/approval/interaction/delegated-review/monitor, blocker owner
and action, continuation, or recovery action required by Section 18. A reported
`done` never directly closes an issue. Board/user status races increment
`issues.status_version`; the losing native finalizer reloads and appends a
superseding assessment instead of overwriting organizational authority.

## Existing lifecycle mapping

| Paperclip concern | Standalone mapping | Owner |
|---|---|---|
| Checkout and issue execution lock | Unchanged; resolved before native selection | Existing issue/heartbeat services |
| Budget and pause gate | Unchanged pre-dispatch check | Existing budget/invokability services |
| Workspace preparation | Unchanged; native receives the realized cwd/target only | Environment/workspace orchestrators |
| Session execution | `NativeSessionBackend` through package-owned runtime loop | Runner package |
| Event validation/reducer semantics | Accepted PRP schemas and reducer | Runner package |
| Event commit/ACK/replay | Bound `ControlPlanePort` implementation | Thin server adapter |
| Cancellation | Existing cancel route invokes a registered native cancel handle, then existing terminal cleanup | Heartbeat + package session |
| Workspace finalization | Existing `workspace_finalize` barrier after native execute returns | Heartbeat/workspace services |
| Run terminal state | Validated discriminator after workspace finalization, coordinated with native finalization | Thin adapter + native finalizer |
| Issue status | Section 18 assessment, arbitration, CAS, and atomic liveness effects | Native finalizer + existing issue/governance services |
| Approvals/interactions | Typed native bridge materializes through existing services; unsupported/forged requests fail closed and cannot self-approve | Native interaction bridge + existing governance services |
| Usage/cost/session state | Converted to existing `AdapterExecutionResult` fields | Existing heartbeat finalizer |
| Audit/live events | Existing activity and heartbeat event publication | Existing services |
| Lease/runtime/scratch release | Existing `finally` path | Existing heartbeat/environment services |

### Cancellation seam

The heartbeat service already cancels process-backed adapters through
`runningProcesses`. Native sessions need one additional run-scoped registry of
idempotent cancel functions. `cancelRunInternal`, agent pause, budget pause, and
shutdown drain call the same registry before their current status/cleanup
writes. The package implementation performs `session.cancel`/`interrupt` and
`close`; provider process escalation remains package-owned. Registering a
cancel handle does not grant status authority.

## Native event persistence and replay

The first slice extends `heartbeat_run_events` rather than creating a parallel
operator timeline. Nullable native-source columns keep legacy rows unchanged:

```text
source_instance_id
source_event_id
source_seq
source_payload_sha256
protocol_schema_version
```

Required unique indexes (the source identities are partial):

```text
(run_id, seq)
(run_id, source_event_id) where source_event_id is not null
(run_id, source_instance_id, source_seq)
  where source_instance_id is not null and source_seq is not null
```

Every writer uses one server-owned `appendHeartbeatRunEvent` transaction.
`nextRunEventSeq(max(seq)+1)` is removed. The transaction:

1. validates the event and bound company/run/agent identity;
2. locks the owning `heartbeat_runs` row `FOR UPDATE`;
3. checks source-event/source-sequence deduplication before allocating a
   canonical sequence;
4. canonicalizes and hashes the complete event payload;
5. inserts with `seq = heartbeat_runs.next_event_seq`, then increments
   `next_event_seq` in the same transaction;
6. on a dedup conflict, loads the canonical row and accepts only an equivalent
   hash without consuming a sequence;
7. computes the highest contiguous committed native source sequence; and
8. publishes/acknowledges only after commit.

The same allocator is mandatory for lifecycle, stdout/stderr, cancellation,
workspace, adapter, recovery, and native PRP events. Publication happens from
the committed row/outbox, never between allocation and commit. Concurrent
cancel/lifecycle/native appends therefore serialize on the per-run row and the
database unique `(run_id, seq)` constraint is the final guard.

The expand migration changes event `seq` and run `next_event_seq` to `bigint`.
For each existing run it first preserves the earliest row for every existing
sequence; if historical duplicates exist, it deterministically moves only the
later duplicates (ordered by `created_at, id`) to fresh values above that run's
old maximum and records duplicate counts in migration verification output. It
then sets `next_event_seq = max(seq) + 1` (or `1` for an empty run), installs
the unique constraint, and only then deploys the shared writer. Legacy event
payloads/source-null behavior are unchanged; no synthetic native source fields
or finalization history are backfilled.

Replay reads the same rows by the bound run/source instance, ordered by
`source_seq`, after an exclusive cursor. A gap is reported and never hidden by
canonical server sequence. Legacy rows have null native-source fields and are
unaffected. Existing `/api/heartbeat-runs/:runId/events` remains the operator
read path; no new public mutation route is required.

## Failure behavior

1. Failures before mode persistence use the existing setup-failure path.
2. A native eligibility/configuration error never invokes a provider.
3. After native mode is persisted, every error stays native and uses a stable
   `native_*` error code; there is no legacy retry for that run.
4. Missing, inconsistent, or invalid `nativeFinalization` fails the run with
   `native_finalization_missing` or `native_finalization_invalid`.
5. Workspace-finalization failure wins over a successful reported result. The
   report remains persisted for inspection, the run is failed, and issue status
   is preserved.
6. Cancellation is idempotent. Late native completion cannot overwrite a
   cancelled heartbeat run because the existing conditional terminal write
   remains authoritative.
7. Event replay conflict, company mismatch, auth mismatch, unsafe payload, or
   acknowledgement ambiguity fails closed and never mutates issue governance.
8. A native runtime request that the tracer does not support is declined with
   `native_runtime_request_unsupported`; it is not auto-approved.

## Mock-versus-real conformance strategy

The package exports one table-driven `ControlPlanePort` conformance suite. It
runs unchanged against:

1. `MockControlPlaneAdapter`, with deterministic in-memory storage; and
2. `PaperclipControlPlanePort`, with a real test database, heartbeat run, issue,
   agent, and company binding.

Both adapters produce a normalized snapshot containing canonical PRP events,
source cursors, duplicate dispositions, terminal result, and failure code. The
suite compares snapshots while excluding database IDs and wall-clock fields.
The real suite adds authorization and transaction assertions that a mock cannot
prove. A separate deterministic fake backend drives both ports. Real Codex is a
smoke proof only and does not replace the deterministic matrix.

Required shared cases:

- open, append, terminal happy path;
- ordered replay after every cursor;
- identical duplicate event and terminal replay;
- conflicting duplicate ID and conflicting source sequence;
- source gap and recovery after missing event arrives;
- wrong run/session/company/agent identity;
- terminal before result and event after terminal;
- cancellation before turn, during turn, and after terminal;
- connection loss before and after commit acknowledgement.
- concurrent lifecycle, cancellation, native, and log appends with one
  gap-free canonical server sequence and stable replay after restart;
- terminal-result replay before/after acknowledgement with one canonical
  `native_run_results` row and one finalization coordinator;
- process loss and flag disablement after result persistence, proving recovery
  uses only the persisted native run envelope.

## Test matrix

| ID | Concern | Mock | Real Paperclip | Legacy assertion |
|---|---|---:|---:|---|
| P6-01 | Default flag off | — | yes | `adapter.execute` called exactly once; no native rows |
| P6-02 | Per-agent opt-in absent | — | yes | Same as current path |
| P6-03 | Eligible native selection | yes | yes | Legacy adapter not called |
| P6-04 | Persisted mode survives flag change | yes | yes | No mid-run mode switch |
| P6-05 | Kill switch before dispatch | — | yes | New run uses legacy once |
| P6-06 | Workspace cwd/branch/identity | yes | yes | Same realized workspace and finalize barrier |
| P6-07 | Workspace finalize failure | yes | yes | Failed run; result preserved; issue unchanged |
| P6-08 | Budget blocked before dispatch | — | yes | Neither native nor legacy provider starts |
| P6-09 | Budget hard stop during native run | yes | yes | One cancel, normal lease/resource cleanup |
| P6-10 | Manual/agent-pause cancellation | yes | yes | Idempotent native cancel and terminal race guard |
| P6-11 | PRP append/ACK/replay | yes | yes | Legacy event rows unchanged |
| P6-12 | Duplicate replay | yes | yes | One semantic event, stable cursor |
| P6-13 | Conflicting replay | yes | yes | Native fails closed; no legacy fallback |
| P6-14 | Cross-company/run/agent forgery | — | yes | Generic denial, zero rows, no disclosure |
| P6-15 | Typed input/credential isolation | yes | yes | JWT, API key, MCP credentials, wake/skills, raw env/context canaries absent from package and model |
| P6-16 | Durable mode/result recovery | yes | yes | Restart/flag-off/process-loss resumes persisted native result and coordinator |
| P6-17 | Canonical allocator concurrency | yes | yes | Lifecycle/cancel/native/log writers produce unique `(run_id, seq)` and stable replay |
| P6-18 | Migration/backfill | — | yes | Legacy duplicate repair, `next_event_seq`, bigint, uniqueness, and null native fields proven |
| P6-19 | Terminal result idempotency/conflict | yes | yes | One canonical result/finalization; changed bytes fail closed |
| P6-20 | Reported `done` with satisfied contract | yes | yes | Claim stored; server assessment/arbiter/committer applies authoritative `done` once |
| P6-21 | Incomplete/rejected evidence | yes | yes | Arbiter preserves or creates a valid blocker/review/continuation path; never trusts prose |
| P6-22 | Governance/status forgery | yes | yes | Caller status/policy/approval fields rejected; zero authoritative effects |
| P6-23 | Native interaction bridge | yes | yes | Durable materialization/typed response, no invalid issue status or credential exposure |
| P6-24 | Board/cancel/dependency race | yes | yes | `status_version` CAS and superseding assessment; no reopen/duplicate effect |
| P6-25 | Missing/invalid native finalization | yes | yes | Native run fails with named recovery; no legacy heuristic |
| P6-26 | Workspace finalization ordering | yes | yes | Workspace success precedes assessment; failure prevents `done` and preserves claim |
| P6-27 | Non-terminal liveness effects | yes | yes | Reviewer/blocker/continuation/recovery entity commits atomically with status |
| P6-28 | Kill switch during arbitration | yes | yes | Existing native coordinator finishes/reconciles; new run selects legacy |
| P6-29 | Cost/usage/session projection | yes | yes | Existing field meanings unchanged |
| P6-30 | Activity/live/effect ledger | — | yes | Selection/result/decision/effects/cancel audited and published once |
| P6-31 | Section 18.13 corpus | yes | yes | Every SD/TC/ATT/LIVE/REC/COMP/MIG fixture emits a joinable consumer result |
| P6-32 | Full legacy targeted regression | — | yes | Byte-equivalent result/events/UI-read snapshot; zero native history rows |

## Exact implementation sequence

1. Reconcile `ControlPlanePort` with accepted PRP events/results and add the
   shared mock conformance suite. No core files change in this step.
2. Add the package-local `HarnessDriver` to `NativeSessionBackend` adapter and a
   deterministic fake-backend executor. Keep provider/process logic packaged.
3. Expand storage: add first-class run-mode/contract/sequence fields, native
   result/finalization/assessment/decision/effect tables, `issues.status_version`,
   and nullable native event-source columns. Run production-shaped migration
   and legacy snapshot tests before enabling any writer.
4. Replace every heartbeat event writer with the shared per-run transactional
   allocator, backfill `next_event_seq`, add unique `(run_id, seq)`, and prove
   concurrent lifecycle/cancel/native/log appends.
5. Implement the server-bound `PaperclipControlPlanePort` with constructor
   binding, canonical-byte deduplication, commit-before-ACK replay, and terminal
   result idempotency.
6. Add the default-off instance flag, parse the per-agent profile, materialize
   immutable completion contracts, and persist the resolved native run envelope
   before invocation. Test resolver/kill-switch precedence and restart recovery.
7. Add strict `NativeExecutionInputV1`/`NativeModelEnvelopeV1` validators and
   the explicit constructor. Prove forbidden legacy context and credential
   canaries cannot reach package, driver, model, event, result, log, or digest.
8. Add `nativeFinalization` to `AdapterExecutionResult`, the package executor,
   native cancel registry, and the single heartbeat branch. Keep legacy JWT,
   MCP, prompt/context, and adapter invocation construction entirely on the
   legacy branch.
9. Implement the Section 18 services: result ingestion, workspace-first native
   finalization, evidence classification, assessment, pure arbiter, serialized
   decision/effect commit, interaction bridge, and reconciler. Version every
   existing issue-status writer before enabling native application.
10. Execute MIG-01 through MIG-05 with the unchanged Section 18.13 fixture
    corpus. Resolve every unexplained shadow divergence; do not waive cases.
11. Enable MIG-06 only for one isolated company/agent, run mock and database
    conformance, governance/status, workspace, budget/cancel, disconnect,
    terminal replay, and legacy regression proofs, then disable new dispatch.
12. Add the package-local tracer/tutorial/evidence and run one safe local Codex
    task only after deterministic tests pass. Stop for mandatory Security and
    CTO implementation review before QA or wider opt-in.

## Exact files that may change

### Package-owned contract, implementation, tests, and evidence

```text
packages/paperclip-runner/package.json
packages/paperclip-runner/src/index.ts
packages/paperclip-runner/src/contracts/control-plane-port.ts
packages/paperclip-runner/src/contracts/native-session-backend.ts
packages/paperclip-runner/src/contracts/types.ts
packages/paperclip-runner/src/mock-core/mock-control-plane-adapter.ts
packages/paperclip-runner/src/mock-core/mock-control-plane-adapter.test.ts
packages/paperclip-runner/src/backends/harness-driver-backend.ts              (new)
packages/paperclip-runner/src/backends/harness-driver-backend.test.ts         (new)
packages/paperclip-runner/src/conformance/control-plane-port.ts               (new)
packages/paperclip-runner/src/conformance/control-plane-port.test.ts          (new)
packages/paperclip-runner/src/cli/paperclip-adapter.ts                            (new)
packages/paperclip-runner/protocol/fixtures/standalone/*                         (new)
packages/paperclip-runner/docs/standalone-thin-paperclip-adapter.md              (new)
packages/paperclip-runner/docs/tutorials/standalone-thin-paperclip-adapter.md
packages/paperclip-runner/docs/tutorials/end-to-end.md
packages/paperclip-runner/docs/index.md
packages/paperclip-runner/docs/architecture.md
packages/paperclip-runner/.paperclip-local/log.md
```

### Paperclip storage, adapter, finalizer, and read seam

```text
server/package.json
packages/adapter-utils/src/types.ts
packages/shared/src/types/instance.ts
packages/shared/src/types/native-finalization.ts                         (new)
packages/shared/src/validators/instance.ts
packages/shared/src/validators/native-finalization.ts                    (new)
packages/shared/src/constants.ts
packages/shared/src/feature-catalog.ts
packages/db/src/schema/heartbeat_runs.ts
packages/db/src/schema/heartbeat_run_events.ts
packages/db/src/schema/issues.ts
packages/db/src/schema/completion_contracts.ts                           (new)
packages/db/src/schema/native_run_results.ts                             (new)
packages/db/src/schema/native_run_finalizations.ts                       (new)
packages/db/src/schema/work_assessments.ts                               (new)
packages/db/src/schema/status_decisions.ts                               (new)
packages/db/src/schema/status_decision_effects.ts                        (new)
packages/db/src/schema/index.ts
packages/db/src/migrations/<generated>.sql
packages/db/src/migrations/meta/*                                        (generated only)
server/src/services/instance-settings.ts
server/src/services/heartbeat-run-events.ts                              (new)
server/src/services/native-runtime/runtime-mode.ts                       (new)
server/src/services/native-runtime/native-execution-input.ts             (new)
server/src/services/native-runtime/paperclip-control-plane-port.ts        (new)
server/src/services/native-runtime/native-session-runtime.ts              (new)
server/src/services/native-runtime/completion-contracts.ts                (new)
server/src/services/native-runtime/native-result-ingestion.ts             (new)
server/src/services/native-runtime/native-run-finalizer.ts                 (new)
server/src/services/native-runtime/evidence-classifier.ts                 (new)
server/src/services/native-runtime/work-assessments.ts                     (new)
server/src/services/native-runtime/status-arbiter.ts                       (new)
server/src/services/native-runtime/status-decision-committer.ts            (new)
server/src/services/native-runtime/native-interaction-bridge.ts            (new)
server/src/services/native-runtime/native-finalization-reconciler.ts       (new)
server/src/services/native-runtime/index.ts                                (new)
server/src/services/issue-thread-interactions.ts
server/src/services/issues.ts
server/src/services/heartbeat.ts
server/src/routes/issues.ts
server/src/routes/agents.ts
server/src/routes/openapi.ts
server/src/__tests__/native-runner-standalone.integration.test.ts             (new)
server/src/__tests__/heartbeat-native-runner-selection.test.ts            (new)
server/src/__tests__/heartbeat-native-runner-cancellation.test.ts         (new)
server/src/__tests__/heartbeat-run-event-sequencing.test.ts               (new)
server/src/__tests__/native-runner-input-boundary.test.ts                  (new)
server/src/__tests__/native-run-finalizer.test.ts                          (new)
server/src/__tests__/native-status-arbiter-corpus.test.ts                  (new)
server/src/__tests__/native-finalization-recovery.test.ts                  (new)
server/src/__tests__/native-finalization-migration.test.ts                 (new)
server/src/__tests__/legacy-finalization-regression.test.ts                (new)
```

No other file is pre-approved. The migration owns the universal
`status_version` increment (a database trigger on an actual status change), so
Standalone does not scatter versioning edits across unrelated writers. The native
committer calls transaction-aware existing issue, blocker, review, interaction,
recovery, wake, activity, and live-event entry points; if one of those files
must change to expose such an entry point, implementation pauses for an
allowlist amendment and CTO review. In particular, Standalone must not change a
concrete legacy adapter, approval authority, browser UI, workspace policy,
budget policy, or activity semantics merely to make the tracer pass.

### Remediation allowlist amendment (2026-08-09)

The implementation review found four seam-local paths whose names differed
from the provisional list above. They are added without expanding authority:

```text
packages/paperclip-runner/src/native-session-runtime.ts
packages/paperclip-runner/src/native-session-runtime.test.ts
packages/paperclip-runner/src/contracts/native-execution.ts
packages/paperclip-runner/src/contracts/native-execution.test.ts
packages/paperclip-runner/src/backends/codex-native-backend.ts
packages/paperclip-runner/spec/fixtures/status-authority-sdk.json
packages/adapter-utils/package.json
packages/shared/src/index.ts
packages/shared/src/types/index.ts
packages/shared/src/validators/index.ts
server/src/services/native-runtime/native-session-executor.ts
server/src/services/native-runtime/native-session-executor.test.ts
server/src/services/native-runtime/evidence-classifier.test.ts
server/src/services/native-runtime/paperclip-control-plane-port.test.ts
server/src/services/native-runtime/status-arbiter.test.ts
server/src/services/recovery/service.ts
packages/paperclip-runner/docs/design/standalone-thin-paperclip-adapter.md
```

The package runtime, closed native-input contract, and Codex backend files own
persisted provider-session recovery and construction. The adapter-utils
metadata declares the package dependency used by the approved native
finalization result type; the shared barrels only expose the already-reviewed
types and validators. The recovery service touch reuses the existing
source-scoped recovery action and wake path rather than creating new authority.
The corpus
edit moves two existing coverage labels between fixtures without changing any
fixture input or expected outcome, eliminating an unjoinable fixture. The server
executor files own only the run-scoped cancellation handle and coordinator
lease around that package runtime. The colocated port and arbiter tests exercise
the same approved database and pure-policy seams exposed through the named
`server/src/__tests__` matrix entry points. This amendment does not authorize
changes to a concrete legacy adapter, approval authority, UI, workspace policy,
budget policy, or runner/provider/session behavior outside the package.

### Remediation 2 test-seam amendment (2026-08-09)

The following already-listed files receive one provider-boundary test seam for
the persisted recovery proof:

```text
server/src/services/heartbeat.ts
server/src/services/native-runtime/native-session-executor.ts
server/src/__tests__/native-session-resumption.test.ts
server/src/__tests__/native-status-arbiter-corpus.test.ts
```

`heartbeatService` may receive an optional native-backend factory, and the
native session executor may receive the resulting `NativeSessionBackend`.
Production supplies neither option and therefore still constructs the
package-owned Codex backend exactly as before. The embedded-PostgreSQL test
uses this seam only at the external provider boundary; it still executes the
production orphan reaper, database lease claim, `executeRun`, package session
recovery, control-plane port, workspace barrier, evidence classifier, status
committer, finalizer, and terminal heartbeat projection. No package contract,
provider/session behavior, legacy adapter, approval authority, workspace
policy, or UI surface changes.

### Remediation 3 production-policy and corpus amendment (2026-08-09)

The following production files were already listed in the approved authority
seams above. This amendment explicitly permits corpus-conformance vocabulary
and return-shape corrections inside those seams; it grants no new authority:

```text
server/src/services/native-runtime/status-arbiter.ts
server/src/services/native-runtime/status-decision-committer.ts
server/src/services/native-runtime/native-run-finalizer.ts
server/src/services/native-runtime/native-interaction-bridge.ts
server/src/services/native-runtime/native-session-executor.ts
server/src/services/native-runtime/native-finalization-reconciler.ts
server/src/services/native-runtime/runtime-mode.ts
```

The arbiter remains the versioned server-owned policy boundary. The finalizer,
attention, cancellation, reconciliation, compatibility, and migration modules
expose trigger-specific production consumers of that policy. The committer
continues to materialize decisions and effects atomically through existing
issue, interaction, wake, recovery, and activity services. This amendment does
not authorize changes to package contracts, provider/session behavior, a
concrete legacy adapter, approval authority, workspace or budget policy, or UI.

The corpus test remains in its pre-approved matrix path. It creates a
fixture-specific database shape and dispatches the fixture to the responsible
production consumer. All eleven expected fields are derived from consumer
return values and persisted production rows: run status, status/preserve
action, reason, required and forbidden effects, live-path kind, claim
preservation, native-record behavior, decision count, maximum wake count, and
maximum notification count. A separate mutation check changes every expected
field for every fixture and must fail. Every one of the 70 matrix row IDs maps
to a named finalizer, terminal projection, attention, cancellation, committer,
reconciliation, compatibility, or migration consumer, and the row fails if
that consumer did not execute or returned different semantics. No hand-written
test policy table supplies observed outcomes and no row is satisfied by a
coverage-label join to a generic observation.

### Remediation 4 live-consumer and effect-materialization amendment (2026-08-09)

The fixture-keyed scenario arbiter is removed. Finalization now calls the same
fact-based arbiter as the heartbeat finalizer, while attention, cancellation,
reconciliation, compatibility, and migration decisions accept canonical facts
and each has a non-test production caller. The corpus constructs those durable
facts, invokes the production consumer, and uses that return plus persisted
issue, run, decision, interaction, wake, recovery, workspace-operation, and
contract rows as its observation.

`StatusDecisionCommitter` handles every `NativeStatusEffect` explicitly. Each
case creates or changes its named target before its delivered ledger row is
written. Reconciliation acknowledges a pending effect only after its existing
company- and issue-bound target is verified. An unknown effect or target type
throws inside the transaction, leaving the decision, effect ledger, issue
status/version, and finalization coordinator unchanged. Corpus replay calls the
committer twice and requires one decision identity and exactly one delivery
attempt per target; audit-only attention and replacement-turn paths likewise
assert their real target state.

The 52-fixture/70-row proof therefore depends on runtime-reachable consumer
returns and materialized state. Removing a production consumer invocation,
changing its facts or decision, suppressing its target mutation, duplicating a
delivery, or restoring a synthetic `issue_checkout` fallback fails the focused
database gate.

### Remediation 5 live-entrypoint proof amendment (2026-08-09)

The remediation stays within the approved server authority seams and adds one
owning workspace service:

```text
server/src/services/heartbeat.ts
server/src/services/native-runtime/native-session-executor.ts
server/src/services/native-runtime/native-interaction-bridge.ts
server/src/services/native-runtime/native-finalization-reconciler.ts
server/src/services/native-runtime/native-workspace-finalizer.ts
server/src/services/native-runtime/status-decision-committer.ts
server/src/services/native-runtime/runtime-mode.ts
server/src/__tests__/native-status-arbiter-corpus.test.ts
```

Policy resolvers remain pure and may be tested directly, but their return value
is not operational proof. Cancellation fixtures enter through
`cancelNativeSession`, which commits the decision or an explicit audit-only
replacement-turn outcome. Attention fixtures enter through
the persisted accepted-result ingress, which calls `routeNativeAttention`
internally, resolves a same-company eligible delegate, and uses the
company-scoped issue service. REC-04/06/07/08 fixtures enter through
`reconcileNativeFinalizations`; REC-04 invokes the workspace operation recorder
and observes the actual finalizer result. REC-06/07/08 reclassify the persisted
result and contract into a new append-only assessment before an explicitly
authorized superseding commit; REC-07 cannot be selected by an unrelated work
product. MIG-08 uses the instance-global flag through the production heartbeat selector:
persisted native mode wins for an active run and a fresh unresolved run selects
legacy while the agent profile remains unchanged.

`resolveNativeFinalizerStatus`, `resolveNativeAttentionStatus`,
`resolveNativeCancellationStatus`, `resolveNativeReconciliationStatus`, the
compatibility/migration resolvers, and their read models are policy evidence
only when called directly. A fixture claiming an operational effect must also
contain the named live-entrypoint receipt and the owning service's durable
target. Pending-effect replay remains acknowledgement-only and is restricted
to the original company, issue, decision, and still-existing target. Negative
tests deliberately remove each live entrypoint/action and the replay target;
the mapped fixture fails even though the corresponding pure resolver still
returns its expected label.

### Remediation 6 persisted-attention and global-kill-switch amendment (2026-08-09)

Accepted native attention now enters through the runtime finalization call
graph, not through a corpus-owned call to `routeNativeAttention`:

```text
PaperclipControlPlanePort.completeRun
  -> native_run_results (accepted immutable package result)
  -> finalizeNativeRun
  -> routePersistedNativeResultAttention
  -> recordNativeAttentionAssessment
  -> routeNativeAttention
  -> StatusDecisionCommitter
  -> issueService / issueThreadInteractionService / recovery + activity owners
```

The persisted-result ingress derives company, issue, run, agent, result, and
contract identity from database bindings. A same-company eligible delegate is
materialized by `issueService`; a human-authority request is materialized as a
typed issue-thread interaction; an explicit cross-company target is rejected
into an immutable decision, recovery action, failed native finalization, and
activity receipt. The corpus mutates the accepted result row and calls
`finalizeNativeRun`, which owns the persisted-result ingress. The database
integration test starts one layer earlier at
`PaperclipControlPlanePort.completeRun` and then calls the same production
finalizer. `routePersistedNativeResultAttention` and `routeNativeAttention`
remain internal helpers and are no longer accepted as the operational proof.

Audit-only duplicate and stale requests are a terminal success even though
they intentionally create no status decision. The finalizer accepts that shape
only when every request has an `attention_duplicate_suppressed` receipt bound
to the exact durable interaction target. It commits the coordinator with a null
decision, projects the successful heartbeat, and preserves issue status and
version. A committed zero-decision coordinator is replayable only while those
durable receipts remain present; replay does not update the named interaction a
second time. Missing or cross-company interaction bindings fail closed into
named finalization recovery.

MIG-08 now represents the actual instance-global transition. The production
heartbeat selector reads the persisted mode first: an already-selected native
run remains native and can finish or reconcile from its coordinator after
`experimental.enableNativeRunner` turns off. A fresh `paperclip_runner` start
is rejected with `paperclip_runner_rollout_disabled`; direct adapters remain on
their existing legacy paths and are never selected into native execution by an
old runtime profile. The agent configuration is not rewritten, and no second
rollback control is persisted. Re-enabling the instance flag therefore restores
normal fresh-run selection without an operator profile repair.

Sabotage changes the production inputs rather than the policy labels: removing
the persisted-result ingress breaks the attention fixtures, and changing the
global flag input from off to on breaks MIG-08 while
`resolveNativeAttentionStatus` and `resolveNativeMigrationStatus` continue to
return their pure labels. The full recovery test observes both durable
outcomes: the original native rows reach committed terminal state and the
fresh runner start is rejected before creating native result/finalization rows.

This amendment does not add an attention UI, a public native-attention route,
external-system execution, credential delegation, or auto-approval. The Codex
v1 structured-output surface still emits the compact `kind`/`summary` form;
the canonical PRP result can carry richer target metadata, which the server
validates as untrusted routing hints. Richer provider authoring UX and
additional resolver kinds remain deferred.

### Remediation 7 authoritative exact-file reconciliation (2026-08-09)

The provisional list and seam amendments above remain the decision history.
For final diff auditing, their authoritative union is the following exact
89-file allowlist. It matches the Standalone branch diff from the parent of the
authorization commit through this remediation, including the package README,
the Section 18.13 checker, package/runtime tests, `canonical.ts`, and
`runtime-mode.test.ts`. No file outside this list is authorized as Standalone work.

```text
packages/adapter-utils/package.json
packages/adapter-utils/src/types.ts
packages/db/src/migrations/0211_famous_guardsmen.sql
packages/db/src/migrations/meta/0211_snapshot.json
packages/db/src/migrations/meta/_journal.json
packages/db/src/schema/completion_contracts.ts
packages/db/src/schema/heartbeat_run_events.ts
packages/db/src/schema/heartbeat_runs.ts
packages/db/src/schema/index.ts
packages/db/src/schema/issues.ts
packages/db/src/schema/native_run_finalizations.ts
packages/db/src/schema/native_run_results.ts
packages/db/src/schema/status_decision_effects.ts
packages/db/src/schema/status_decisions.ts
packages/db/src/schema/work_assessments.ts
packages/paperclip-runner/README.md
packages/paperclip-runner/docs/design/standalone-thin-paperclip-adapter.md
packages/paperclip-runner/docs/index.md
packages/paperclip-runner/docs/standalone-thin-paperclip-adapter.md
packages/paperclip-runner/docs/tutorials/standalone-thin-paperclip-adapter.md
packages/paperclip-runner/.paperclip-local/log.md
packages/paperclip-runner/package.json
packages/paperclip-runner/spec/fixtures/status-authority-sdk.json
packages/paperclip-runner/src/backends/codex-native-backend.ts
packages/paperclip-runner/src/backends/harness-driver-backend.test.ts
packages/paperclip-runner/src/backends/harness-driver-backend.ts
packages/paperclip-runner/src/cli/standalone-paperclip.ts
packages/paperclip-runner/src/conformance/control-plane-port.test.ts
packages/paperclip-runner/src/conformance/control-plane-port.ts
packages/paperclip-runner/src/contracts/control-plane-port.ts
packages/paperclip-runner/src/contracts/native-execution.test.ts
packages/paperclip-runner/src/contracts/native-execution.ts
packages/paperclip-runner/src/contracts/native-session-backend.ts
packages/paperclip-runner/src/index.ts
packages/paperclip-runner/src/mock-core/mock-control-plane-adapter.ts
packages/paperclip-runner/src/native-session-runtime.test.ts
packages/paperclip-runner/src/native-session-runtime.ts
packages/shared/src/feature-catalog.ts
packages/shared/src/index.ts
packages/shared/src/types/index.ts
packages/shared/src/types/instance.ts
packages/shared/src/types/native-finalization.ts
packages/shared/src/validators/index.ts
packages/shared/src/validators/instance.ts
packages/shared/src/validators/native-finalization.ts
scripts/check-runner-sdk-spec.mjs
server/package.json
server/src/__tests__/heartbeat-native-runner-cancellation.test.ts
server/src/__tests__/heartbeat-native-runner-selection.test.ts
server/src/__tests__/heartbeat-run-event-sequencing.test.ts
server/src/__tests__/legacy-finalization-regression.test.ts
server/src/__tests__/native-finalization-migration.test.ts
server/src/__tests__/native-finalization-recovery.test.ts
server/src/__tests__/native-interaction-bridge.test.ts
server/src/__tests__/native-run-finalizer.test.ts
server/src/__tests__/native-runner-input-boundary.test.ts
server/src/__tests__/native-runner-standalone.integration.test.ts
server/src/__tests__/native-session-resumption.test.ts
server/src/__tests__/native-status-arbiter-corpus.test.ts
server/src/services/heartbeat-run-events.ts
server/src/services/heartbeat.ts
server/src/services/instance-settings.ts
server/src/services/issues.ts
server/src/services/native-runtime/canonical.ts
server/src/services/native-runtime/completion-contracts.ts
server/src/services/native-runtime/evidence-classifier.test.ts
server/src/services/native-runtime/evidence-classifier.ts
server/src/services/native-runtime/index.ts
server/src/services/native-runtime/native-execution-input.ts
server/src/services/native-runtime/native-finalization-reconciler.ts
server/src/services/native-runtime/native-interaction-bridge.ts
server/src/services/native-runtime/native-result-ingestion.ts
server/src/services/native-runtime/native-run-finalizer.ts
server/src/services/native-runtime/native-session-executor.test.ts
server/src/services/native-runtime/native-session-executor.ts
server/src/services/native-runtime/native-workspace-finalizer.ts
server/src/services/native-runtime/paperclip-control-plane-port.test.ts
server/src/services/native-runtime/paperclip-control-plane-port.ts
server/src/services/native-runtime/runtime-mode.test.ts
server/src/services/native-runtime/runtime-mode.ts
server/src/services/native-runtime/status-arbiter.test.ts
server/src/services/native-runtime/status-arbiter.ts
server/src/services/native-runtime/status-decision-committer.ts
server/src/services/native-runtime/work-assessments.ts
server/src/services/recovery/service.ts
```

## Commands the implementation must make runnable

These commands are the acceptance contract for the implementation issue. They
do not exist yet in this design-only task.

Deterministic package/mock proof:

```sh
pnpm check:runner-sdk-spec

pnpm --filter @paperclipai/paperclip-runner exec vitest run \
  src/conformance/control-plane-port.test.ts \
  src/backends/harness-driver-backend.test.ts

pnpm --filter @paperclipai/paperclip-runner trace:standalone -- \
  --target mock --scenario happy-path
```

First real Paperclip tracer and inspection (against an isolated local dev
instance with the five `PAPERCLIP_*` identifiers/auth variables already set):

```sh
pnpm --filter @paperclipai/paperclip-runner trace:standalone -- \
  --target paperclip --scenario happy-path

PAPERCLIP_API_BASE="${PAPERCLIP_API_URL%/}"
PAPERCLIP_API_BASE="${PAPERCLIP_API_BASE%/api}"
curl -fsS \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_BASE/api/heartbeat-runs/$PAPERCLIP_RUN_ID/events?after=0&limit=200" \
  | jq '[.[] | select(.sourceEventId != null)] | {count: length, events: map({sourceSeq, sourceEventId, eventType})}'
```

Targeted real integration proof:

```sh
pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/native-runner-standalone.integration.test.ts \
  src/__tests__/heartbeat-native-runner-selection.test.ts \
  src/__tests__/heartbeat-native-runner-cancellation.test.ts \
  src/__tests__/heartbeat-run-event-sequencing.test.ts \
  src/__tests__/native-runner-input-boundary.test.ts \
  src/__tests__/native-run-finalizer.test.ts \
  src/__tests__/native-status-arbiter-corpus.test.ts \
  src/__tests__/native-finalization-recovery.test.ts \
  src/__tests__/native-finalization-migration.test.ts \
  src/__tests__/legacy-finalization-regression.test.ts

pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/heartbeat-run-event-sequencing.test.ts \
  -t "serializes concurrent lifecycle cancel native and log writers"

pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/native-status-arbiter-corpus.test.ts \
  -t "executes all 52 fixtures in their production consumers"
```

Legacy fallback proof after disabling the flag:

```sh
pnpm --filter @paperclipai/paperclip-runner trace:standalone -- \
  --target paperclip --scenario legacy-fallback

pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/native-runner-standalone.integration.test.ts \
  -t "uses the unchanged legacy path when the kill switch is off"
```

The tracer must print a stable JSON summary containing `resolvedMode`,
`runtimeModeResolverVersion`, `runStatus`, `reportedWorkDisposition`,
`nativeResultId`, `nativeResultSha256`, `finalizationPhase`, `assessmentId`,
`decisionId`, `authoritativeDecision`, `issueStatusBefore`, `issueStatusAfter`,
`statusVersionBefore`, `statusVersionAfter`, `nativeEventCount`,
`highestContiguousSourceSeq`, `nextEventSeq`, `workspaceFinalizeStatus`, and
`legacyAdapterInvocationCount`. It must never print a bearer token, credential
binding value, wake payload, skill instruction, raw environment, or private
host path.

## Tutorial outline

The implementation fills in the package-local
[Standalone tutorial](../tutorials/standalone-thin-paperclip-adapter.md) with:

1. prerequisites and an isolated local instance;
2. mock conformance first;
3. flag and one-agent opt-in;
4. one safe local native task;
5. canonical event replay, persisted mode/result, and coordinator inspection;
6. Section 18 assessment/decision/effect and `status_version` inspection;
7. cancellation, concurrent append, disconnect recovery, and workspace-first
   finalization checks;
8. explicit credential-boundary canary proof;
9. kill-switch disablement while persisted native recovery still succeeds;
10. a new legacy task proving fallback and zero native rows;
11. cleanup and expected stable summaries.

No production credentials or destructive cleanup command belongs in the
tutorial.

## Acceptance evidence

The package verification run records the git revision, migration revision,
exact commands and exit codes, flag/profile scope, and these redacted machine
artifacts:

- one Section 18.13 result per `{corpusRevision, gitRevision, fixtureId,
  consumer}` with observed digests and semantic row/effect counts;
- migration before/after counts, repaired duplicate event IDs, per-run
  `next_event_seq`, and unique-constraint verification on production-shaped
  legacy data;
- concurrent-writer attempt order plus final canonical event order and the
  byte-equivalent replay snapshot after a simulated restart;
- typed-input canary inventory and negative package/model/event/result/log/
  digest observations (names of forbidden categories, never secret values);
- terminal replay/recovery snapshots before ACK, after ACK, after disconnect,
  with the flag disabled, and after reconciliation;
- one safe real Codex trace showing workspace finalize, preserved claim,
  assessment, applied server decision/effects, and zero legacy invocation;
- one new post-kill-switch legacy trace with byte-equivalent legacy projection
  and zero native contract/result/finalization/decision rows.

The evidence index must call out any expected shadow divergence by fixture ID.
An unexplained divergence, missing consumer result, duplicate semantic effect,
credential-canary hit, or unjoinable aggregate “suite passed” result blocks the
implementation handoff.

## Browser UI decision

No browser component changes are required for the Standalone tracer. The Section
18 company-authorized read models/routes for completion contracts, native
finalization, assessments/decisions, and compact run/issue summaries plus the
package tracer provide inspectable evidence. The flag is server/API-only and
default off. Rendering those read models in the board UI remains bound to the
separately approved Section 18.12 operator UX gate.

## Approval questions

The CTO can approve or reject this record by deciding these five points:

1. Is the one-way package dependency and single heartbeat branch narrow enough?
2. Is the default-off instance flag plus per-agent opt-in an acceptable first
   rollout and kill-switch contract?
3. Is extending `heartbeat_run_events` with the shared per-run allocator and
   unique canonical sequence preferable to a second event store?
4. Does the restored Section 18 native finalizer/arbitration scope, including
   the MIG-04/MIG-05 shadow stages and MIG-06 internal application proof,
   satisfy the normative Standalone gate?
5. Are the allowed files, conformance matrix, and exact tracer/fallback commands
   sufficient to begin implementation?
