# Durable continuation scheduling

Paperclip does not keep an agent process alive between turns. A heartbeat run is
finite: it starts, performs work, records a terminal result, and exits. If work
must continue later, Paperclip represents that intent in database state and
creates another heartbeat run when the continuation becomes eligible.

“Durable continuation scheduler” is a useful umbrella term, but it is not the
name of one class or queue. Two related mechanisms provide the behavior:

1. **Explicit continuation effects** are written by native status arbitration.
2. **Stranded-issue reconciliation** is a startup and periodic safety net for an
   assigned open issue that has no live execution or durable wait path.

The second mechanism produced the repeated `issue_continuation_needed` runs on
DOT-2.

## When it runs

The heartbeat scheduler is enabled unless
`HEARTBEAT_SCHEDULER_ENABLED=false`. Its interval is configured with
`HEARTBEAT_SCHEDULER_INTERVAL_MS` and defaults to 30,000 ms. The configured
value is clamped to a minimum of 10,000 ms.

Continuation recovery runs:

- once during server startup, after orphaned runs are reaped, due retries are
  promoted, and already-queued work is resumed; and
- on every heartbeat scheduler tick, after the same orphan/retry/queue cleanup.

The periodic tick calls `reconcileStrandedAssignedIssues()`. Consequently, a
new recovery run normally appears within one scheduler interval. The interval
is polling cadence, not a promise that every continuation waits exactly that
long.

Explicit native continuation effects do not need to wait for this scan. The
native status-decision committer writes an idempotent `agent_wakeup_requests`
row directly. The normal queued-run machinery then claims it.

## What is durable

The system reconstructs intent from persisted control-plane records rather
than an in-memory timer owned by an agent:

- the issue status and assignee;
- the issue execution lock/run identity;
- heartbeat run status, context, retry ancestry, and terminal timestamps;
- `agent_wakeup_requests` rows;
- native status decisions and their materialized effects;
- pending interactions, approvals, monitors, blockers, and execution stages;
- scheduled retry timestamps and recovery actions.

Because these records survive a process restart, startup reconciliation can
resume queued work or repair an issue whose previous execution disappeared.

## Explicit continuations

A native result can report `yielded` with a continuation containing:

- a kind: `same_agent`, `retry`, `delegated_issue`, `response_wake`, or
  `monitor`;
- a summary; and
- an idempotency key.

The native status arbiter keeps the issue `in_progress` and emits an
`enqueue_continuation` effect. The status-decision committer materializes that
effect as an idempotent wake request. A monitor continuation uses
`monitor_due`; other continuation kinds use `issue_status_changed` at this
boundary.

This is intentional continuation: the result explicitly says more work is
needed and leaves a persisted execution path.

## Stranded-issue reconciliation

`reconcileStrandedAssignedIssues()` scans agent-owned issues in `todo`,
`in_progress`, and relevant `in_review` states. Before creating work, it checks
for reasons not to wake the agent, including:

- an active or queued execution path already exists;
- a pending interaction or durable wait path exists;
- the issue or its tree is paused;
- a provider-quota monitor is pending;
- the run was explicitly cancelled by an operator;
- the assigned agent is not invokable;
- invocation budget or retry/backoff policy prevents a run; or
- recovery has failed enough times that the issue should be escalated instead.

For an eligible `in_progress` issue with no live path, it creates an automated
wake/run with:

```text
wakeReason:  issue_continuation_needed
retryReason: issue_continuation_needed
source:      issue.continuation_recovery
```

This is a liveness repair, not evidence that the previous model requested
another turn. Its invariant is: an assigned open issue should have either a
live execution path, a durable reason to wait, or a visible terminal/blocking
disposition.

## Why DOT-2 looped

DOT-2's runner repeatedly produced a successful result that reported `done`.
The native evidence classifier did not accept the model's evidence references,
so status arbitration preserved `in_progress` and created another continuation
path. After each run exited, the periodic reconciler saw:

```text
assigned + in_progress + successful terminal run + no live/wait path
```

It therefore queued `issue_continuation_needed` again on the next approximately
30-second tick. The new run received the original task title because the native
model envelope also omitted the wake-comment text, so it repeated the same
answer.

The fix has two parts:

- native model input now contains the redacted server-authored task prompt,
  including the current wake comment; and
- ordinary low-risk issue completion can accept a schema-valid completion
  claim, while tools, governed effects, interactions, and approvals keep their
  independent authorization gates.

Thus a completed one-shot task becomes `done`; it is no longer a candidate for
stranded-issue reconciliation.

## How to diagnose a suspected loop

Inspect the latest runs for the issue and compare these fields:

- `invocationSource` — recovery-created runs use `automation`;
- `contextSnapshot.wakeReason`;
- `contextSnapshot.retryReason`;
- `retryOfRunId`;
- terminal run status and `resultJson.authoritativeDecision`;
- `resultJson.issueStatusAfter`;
- issue `status`, `executionRunId`, and pending interactions/monitors;
- lifecycle events explaining enqueue, suppression, escalation, or cleanup.

Repeated successful runs with `wakeReason: issue_continuation_needed`, an
authoritative decision of `in_progress`, and no durable wait path usually mean
the result/disposition contract is failing to converge. Fix the status or
continuation decision; increasing the polling interval only hides the bug.

## Primary implementation locations

- `server/src/index.ts` — startup recovery and periodic heartbeat scheduler.
- `server/src/config.ts` — scheduler enable flag and interval.
- `server/src/services/recovery/service.ts` —
  `reconcileStrandedAssignedIssues()` and recovery wake creation.
- `server/src/services/issue-rewake-throttle.ts` — repeated state-wake
  throttling and progress detection.
- `server/src/services/native-runtime/status-arbiter.ts` — native terminal
  disposition and explicit continuation decisions.
- `server/src/services/native-runtime/status-decision-committer.ts` — durable,
  idempotent materialization of native continuation effects.
- `server/src/services/heartbeat.ts` — run lifecycle, immediate recovery, queue
  promotion, and wake execution.
