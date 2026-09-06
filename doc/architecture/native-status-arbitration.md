# Native status arbitration

Native runner results do not directly mutate an issue's status. The model may
report that work is done, blocked, ready for review, or yielded, but Paperclip's
server remains the authority that decides and commits the resulting workflow
state.

The native status pipeline is:

```text
structured runner result
        |
        v
schema and terminal validation
        |
        v
evidence classification
        |
        v
pure status arbitration
        |
        v
transactional decision commit
        |
        +--> issue status/version
        +--> durable side effects
        +--> audit and recovery records
```

This separation prevents model prose from acting as a privileged status
command, protects newer issue state from stale runs, and makes every decision
replayable and auditable.

## Inputs to finalization

The runner returns a `paperclip.run_result.v1` result and a matching terminal
record. Important result fields include:

- `reportedWorkDisposition`: `done`, `blocked`, `needs_review`, or `yielded`;
- `completionClaim`, including the contract revision, criterion claims, and
  remaining work;
- `verification` claims;
- evidence references;
- an optional blocker; and
- an optional continuation.

The server also owns facts the runner cannot choose:

- the persisted completion contract;
- the run's actual terminal state;
- whether workspace finalization succeeded;
- the issue's current status and status version;
- pending approvals, interactions, and execution-policy stages; and
- the completion-authority policy recorded on the contract.

## Evidence classification

`classifyNativeEvidence()` compares model claims with durable Paperclip
records. It recognizes these evidence families:

- run events with an authoritative control-plane evidence verdict;
- issue work products;
- approvals;
- issue-thread interactions; and
- attachments.

Each evidence reference becomes one of:

| Outcome | Meaning |
| --- | --- |
| `accepted` | A matching durable record exists and authoritatively supports the claim. |
| `missing` | The required claim or referenced record does not exist or is still pending. |
| `rejected` | The record or claim explicitly contradicts completion. |
| `unverifiable` | A record exists, or a string was supplied, but it is not authoritative evidence. |

For example, a model-authored reference such as `task-response` is not trusted
merely because it looks descriptive. Likewise, the model's own
`run.result.proposed` event is a claim, not independent proof.

The classifier produces a `NativeEvidenceAssessment` containing:

- contract-revision validity;
- criterion claim and evidence outcomes;
- verification claim and evidence outcomes;
- accepted, missing, rejected, and unverifiable references;
- blocking remaining work;
- normalized blocker or continuation data; and
- pending attention requests.

The classifier does not update the issue.

## Completion authority

The persisted completion contract controls how a `done` claim may be accepted.

### Durable-evidence completion

The strongest completion path requires all of the following:

- the runner reports `done`;
- the objective is satisfied;
- every contract criterion has accepted durable evidence;
- every verification has accepted durable evidence; and
- no remaining work blocks completion.

This produces `completion_contract_satisfied`.

### Low-risk claim-policy completion

Ordinary issue completion changes Paperclip workflow state, but it does not by
itself authorize deployments, spending, secret access, approvals, or arbitrary
API calls. Default native completion contracts therefore use low-risk
`agent_claim_policy` authority.

Under that policy, a result can complete the issue when:

- it reports `done`;
- its contract revision matches;
- every contract criterion is claimed `satisfied`;
- every verification is claimed `passed`; and
- no remaining work blocks completion.

This produces `completion_claim_policy_accepted`. Independently governed tools
and effects still enforce their own authorization and approval rules.

## Decision order

`arbitrateNativeStatus()` is a pure function. It evaluates higher-authority
conditions before model disposition:

| Condition | Status decision | Important effects/reason |
| --- | --- | --- |
| Issue is already `done` or `cancelled` | Preserve | `terminal_status_preserved` |
| Workspace finalization failed | Preserve | Record a retryable finalization error |
| Run was cancelled | Preserve | Release run resources |
| Run failed | Preserve | Schedule recovery |
| Approval, interaction, or execution stage is pending | `in_review` | Materialize/bind the governance gate and notify its owner |
| Completion satisfies its authority policy | `done` | Release checkout |
| Runner reports `needs_review` | `in_review` | Bind a reviewer and notify the owner |
| Runner reports a task-wide blocker | `blocked` | Persist blocker owner and unblock action |
| Runner reports a current-track blocker | `in_progress` | Enqueue another productive track |
| Runner reports `yielded` with a valid continuation | `in_progress` | Enqueue the declared continuation |
| Completion evidence is incomplete and continuation is forbidden | Preserve | Record a finalization error and named next action |
| Completion evidence is otherwise incomplete | `in_progress` | Enqueue a bounded, idempotent continuation |

The output is a `NativeStatusDecision` containing:

- the arbiter policy version;
- `statusAction` and `toStatus`;
- a stable reason code;
- an optional unblock descriptor; and
- declarative side effects.

The pure arbiter performs no database or network writes.

## Transactional decision commit

`commitNativeStatusDecision()` applies the decision against authoritative issue
state. It uses the issue's prior status, status version, and prior decision ID
as compare-and-swap inputs. If another actor changed the issue first, the commit
raises `NativeStatusRaceError`; finalization reloads current state, reassesses,
and retries a bounded number of times.

Within the transaction, the committer:

1. validates that the assessment and issue bindings still match;
2. records the status decision and reason;
3. updates the issue status and increments its version when required;
4. materializes declared effects;
5. writes an effect ledger with deterministic idempotency keys;
6. updates the native-finalization coordinator; and
7. persists audit activity.

After commit, activity publications are emitted. Reconciliation may redeliver a
pending effect, but it resumes the recorded ledger decision; it does not ask the
model or arbiter to invent a new decision.

## Durable side effects

Depending on the decision, materialized effects may include:

- an idempotent agent wake request;
- an issue-thread interaction;
- a reviewer binding or owner notification;
- a persisted blocker and unblock action;
- a scheduled retry or recovery action;
- a delegated child issue;
- checkout/resource release; or
- finalization/reconciliation records.

Effect rows bind company, issue, decision, target, ordinal, delivery state, and
idempotency key. This is what makes a status transition with follow-up work
recoverable after a process crash.

## Governance precedence

A model cannot bypass a pending governance gate by reporting `done`. Before
completion is considered, finalization checks:

- an active execution-policy stage;
- a pending issue-thread interaction; and
- a pending or revision-requested approval linked to the issue.

If one exists, the issue goes to `in_review` and the durable gate remains the
path forward.

## Failure and recovery behavior

Status finalization is coordinated by `native_run_finalizations`. Important
phases include observation, workspace finalization, assessment, arbitration,
commit, and retryable or terminal failure.

Examples:

- a workspace-finalization failure preserves the claim and records a retryable
  error rather than falsely completing the issue;
- a failed provider run preserves partial evidence and schedules recovery;
- a status-version race causes bounded reassessment against current issue
  state; and
- a materialization failure records the failed phase and next retry time rather
  than silently dropping the side effect.

## Diagnosing an unexpected status

Start with the terminal heartbeat run and inspect:

1. `resultJson.nativeResult.reportedWorkDisposition`;
2. completion-claim contract revision and criterion statuses;
3. verification statuses and evidence references;
4. `resultJson.assessmentId` and `decisionId`;
5. `resultJson.authoritativeDecision`;
6. `resultJson.issueStatusBefore` and `issueStatusAfter`;
7. `finalizationPhase` and `workspaceFinalizeStatus`; and
8. pending approvals, interactions, execution stages, blockers, or
   continuations on the issue.

Common patterns:

- `done` claim + `in_progress` decision: evidence/claim policy did not accept
  completion, or blocking work remained;
- `done` claim + `in_review`: a governance gate took precedence;
- successful run + unchanged status + retryable finalization: workspace or
  status-effect commit failed;
- repeated `issue_continuation_needed` runs: the issue remains open without a
  converging completion or durable wait path; and
- terminal issue unchanged by a stale run: terminal-state preservation or
  status-version race protection worked as designed.

## Primary implementation locations

- `server/src/services/native-runtime/evidence-classifier.ts` — validates
  claims against durable records.
- `server/src/services/native-runtime/status-arbiter.ts` — pure policy and
  decision table.
- `server/src/services/native-runtime/status-decision-committer.ts` — CAS
  commit, effect materialization, ledger, and audit.
- `server/src/services/native-runtime/native-run-finalizer.ts` — orchestrates
  assessment, governance checks, arbitration, bounded race retry, and result
  projection.
- `server/src/services/native-runtime/completion-contracts.ts` — creates and
  versions default native completion contracts.
- `server/src/services/native-runtime/native-finalization-reconciler.ts` —
  resumes interrupted finalization without re-inventing committed decisions.
- `server/src/services/recovery/service.ts` — repairs open issues that finish
  without a live or durable wait path.

See also
[`durable-continuation-scheduler.md`](./durable-continuation-scheduler.md) for
the scheduler and recovery behavior that follows an `in_progress` decision.
