# Execution Semantics

Status: Current implementation guide
Date: 2026-04-23
Audience: Product and engineering

This document explains how Paperclip interprets issue assignment, issue status, execution runs, wakeups, parent/sub-issue structure, and blocker relationships.

`doc/SPEC-implementation.md` remains the V1 contract. This document is the detailed execution model behind that contract.

## 1. Core Model

Paperclip separates four concepts that are easy to blur together:

1. structure: parent/sub-issue relationships
2. dependency: blocker relationships
3. ownership: who is responsible for the issue now
4. execution: whether the control plane currently has a live path to move the issue forward

The system works best when those are kept separate.

## 2. Assignee Semantics

An issue has at most one assignee.

- `assigneeAgentId` means the issue is owned by an agent
- `assigneeUserId` means the issue is owned by a human board user
- both cannot be set at the same time

This is a hard invariant. Paperclip is single-assignee by design.

## 3. Status Semantics

Paperclip issue statuses are not just UI labels. They imply different expectations about ownership and execution.

### `backlog`

The issue is not ready for active work.

- no execution expectation
- no pickup expectation
- safe resting state for future work

### `todo`

The issue is actionable but not actively claimed.

- it may be assigned or unassigned
- no checkout/execution lock is required yet
- for agent-assigned work, Paperclip may still need a wake path to ensure the assignee actually sees it

### `in_progress`

The issue is actively owned work.

- requires an assignee
- for agent-owned issues, this is a strict execution-backed state
- for user-owned issues, this is a human ownership state and is not backed by heartbeat execution

For agent-owned issues, `in_progress` should not be allowed to become a silent dead state.

### `blocked`

The issue cannot proceed until something external changes.

This is the right state for:

- waiting on another issue
- waiting on a human decision
- waiting on an external dependency or system
- work that automatic recovery could not safely continue

### `in_review`

Execution work is paused because the next move belongs to a reviewer or approver, not the current executor.

### `done`

The work is complete and terminal.

### `cancelled`

The work will not continue and is terminal.

## 4. Agent-Owned vs User-Owned Execution

The execution model differs depending on assignee type.

### Agent-owned issues

Agent-owned issues are part of the control plane's execution loop.

- Paperclip can wake the assignee
- Paperclip can track runs linked to the issue
- Paperclip can recover some lost execution state after crashes/restarts

### User-owned issues

User-owned issues are not executed by the heartbeat scheduler.

- Paperclip can track the ownership and status
- Paperclip cannot rely on heartbeat/run semantics to keep them moving
- stranded-work reconciliation does not apply to them

This is why `in_progress` can be strict for agents without forcing the same runtime rules onto human-held work.

## 5. Checkout and Active Execution

Checkout is the bridge from issue ownership to active agent execution.

- checkout is required to move an issue into agent-owned `in_progress`
- `checkoutRunId` represents issue-ownership lock for the current agent run
- `executionRunId` represents the currently active execution path for the issue

These are related but not identical:

- `checkoutRunId` answers who currently owns execution rights for the issue
- `executionRunId` answers which run is actually live right now

Paperclip already clears stale execution locks and can adopt some stale checkout locks when the original run is gone.

## 6. Parent/Sub-Issue vs Blockers

Paperclip uses two different relationships for different jobs.

### Parent/Sub-Issue (`parentId`)

This is structural.

Use it for:

- work breakdown
- rollup context
- explaining why a child issue exists
- waking the parent assignee when all direct children become terminal

Do not treat `parentId` as execution dependency by itself.

### Blockers (`blockedByIssueIds`)

This is dependency semantics.

Use it for:

- \"this issue cannot continue until that issue changes state\"
- explicit waiting relationships
- automatic wakeups when all blockers resolve

Blocked issues should stay idle while blockers remain unresolved. Paperclip should not create a queued heartbeat run for that issue until the final blocker is done and the `issue_blockers_resolved` wake can start real work.

If a parent is truly waiting on a child, model that with blockers. Do not rely on the parent/child relationship alone.

## 7. Consistent Execution Path Rules

For agent-assigned, non-terminal, actionable issues, Paperclip should not leave work in a state where nobody is working it and nothing will wake it.

The relevant execution path depends on status.

### Agent-assigned `todo`

This is dispatch state: ready to start, not yet actively claimed.

A healthy dispatch state means at least one of these is true:

- the issue already has a queued/running wake path
- the issue is intentionally resting in `todo` after a successful agent heartbeat, not after an interrupted dispatch
- the issue has been explicitly surfaced as stranded

### Agent-assigned `in_progress`

This is active-work state.

A healthy active-work state means at least one of these is true:

- there is an active run for the issue
- there is already a queued continuation wake
- the issue has been explicitly surfaced as stranded

## 8. Crash and Restart Recovery

Paperclip now treats crash/restart recovery as a stranded-assigned-work problem, not just a stranded-run problem.

There are two distinct failure modes.

### 8.1 Stranded assigned `todo`

Example:

- issue is assigned to an agent
- status is `todo`
- the original wake/run died during or after dispatch
- after restart there is no queued wake and nothing picks the issue back up

Recovery rule:

- if the latest issue-linked run failed/timed out/cancelled and no live execution path remains, Paperclip queues one automatic assignment recovery wake
- if that recovery wake also finishes and the issue is still stranded, Paperclip moves the issue to `blocked` and posts a visible comment

This is a dispatch recovery, not a continuation recovery.

### 8.2 Stranded assigned `in_progress`

Example:

- issue is assigned to an agent
- status is `in_progress`
- the live run disappeared
- after restart there is no active run and no queued continuation

Recovery rule:

- Paperclip queues one automatic continuation wake
- if that continuation wake also finishes and the issue is still stranded, Paperclip moves the issue to `blocked` and posts a visible comment

This is an active-work continuity recovery.

## 9. Startup and Periodic Reconciliation

Startup recovery and periodic recovery are different from normal wakeup delivery.

On startup and on the periodic recovery loop, Paperclip now does four things in sequence:

1. reap orphaned `running` runs
2. resume persisted `queued` runs
3. reconcile stranded assigned work
4. scan silent active runs and create or update explicit watchdog review issues

The stranded-work pass closes the gap where issue state survives a crash but the wake/run path does not. The silent-run scan covers the separate case where a live process exists but has stopped producing observable output.

## 10. Silent Active-Run Watchdog

An active run can still be unhealthy even when its process is `running`. Paperclip treats prolonged output silence as a watchdog signal, not as proof that the run is failed.

The recovery service owns this contract:

- classify active-run output silence as `ok`, `suspicious`, `critical`, `snoozed`, or `not_applicable`
- collect bounded evidence from run logs, recent run events, child issues, and blockers
- preserve redaction and truncation before evidence is written to issue descriptions
- create at most one open `stale_active_run_evaluation` issue per run
- honor active snooze decisions before creating more review work
- build the `outputSilence` summary shown by live-run and active-run API responses

Suspicious silence creates a medium-priority review issue for the selected recovery owner. Critical silence raises that review issue to high priority and blocks the source issue on the explicit evaluation task without cancelling the active process.

Watchdog decisions are explicit operator/recovery-owner decisions:

- `snooze` records an operator-chosen future quiet-until time and suppresses scan-created review work during that window
- `continue` records that the current evidence is acceptable, does not cancel or mutate the active run, and sets a 30-minute default re-arm window before the watchdog evaluates the still-silent run again
- `dismissed_false_positive` records why the review was not actionable

Operators should prefer `snooze` for known time-bounded quiet periods. `continue` is only a short acknowledgement of the current evidence; if the run remains silent after the re-arm window, the periodic watchdog scan can create or update review work again.

The board can record watchdog decisions. The assigned owner of the watchdog evaluation issue can also record them. Other agents cannot.

## 11. Auto-Recover vs Explicit Recovery vs Human Escalation

Paperclip uses three different recovery outcomes, depending on how much it can safely infer.

### Auto-Recover

Auto-recovery is allowed when ownership is clear and the control plane only lost execution continuity.

Examples:

- requeue one dispatch wake for an assigned `todo` issue whose latest run failed, timed out, or was cancelled
- requeue one continuation wake for an assigned `in_progress` issue whose live execution path disappeared
- assign an orphan blocker back to its creator when that blocker is already preventing other work

Auto-recovery preserves the existing owner. It does not choose a replacement agent.

### Explicit Recovery Issue

Paperclip creates an explicit recovery issue when the system can identify a problem but cannot safely complete the work itself.

Examples:

- automatic stranded-work retry was already exhausted
- a dependency graph has an invalid/uninvokable owner, unassigned blocker, or invalid review participant
- an active run is silent past the watchdog threshold

The source issue remains visible and blocked on the recovery issue when blocking is necessary for correctness. The recovery owner must restore a live path, resolve the source issue manually, or record the reason it is a false positive.

### Human Escalation

Human escalation is required when the next safe action depends on board judgment, budget/approval policy, or information unavailable to the control plane.

Examples:

- all candidate recovery owners are paused, terminated, pending approval, or budget-blocked
- the issue is human-owned rather than agent-owned
- the run is intentionally quiet but needs an operator decision before cancellation or continuation

In these cases Paperclip should leave a visible issue/comment trail instead of silently retrying.

## 12. What This Does Not Mean

These semantics do not change V1 into an auto-reassignment system.

Paperclip still does not:

- automatically reassign work to a different agent
- infer dependency semantics from `parentId` alone
- treat human-held work as heartbeat-managed execution

The recovery model is intentionally conservative:

- preserve ownership
- retry once when the control plane lost execution continuity
- create explicit recovery work when the system can identify a bounded recovery owner/action
- escalate visibly when the system cannot safely keep going

## 13. Practical Interpretation

For a board operator, the intended meaning is:

- agent-owned `in_progress` should mean \"this is live work or clearly surfaced as a problem\"
- agent-owned `todo` should not stay assigned forever after a crash with no remaining wake path
- parent/sub-issue explains structure
- blockers explain waiting

That is the execution contract Paperclip should present to operators.
