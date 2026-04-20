# Execution Semantics

Status: Current implementation guide
Date: 2026-04-13
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

On startup and on the periodic recovery loop, Paperclip now does three things in sequence:

1. reap orphaned `running` runs
2. resume persisted `queued` runs
3. reconcile stranded assigned work

That last step is what closes the gap where issue state survives a crash but the wake/run path does not.

## 10. What This Does Not Mean

These semantics do not change V1 into an auto-reassignment system.

Paperclip still does not:

- automatically reassign work to a different agent
- infer dependency semantics from `parentId` alone
- treat human-held work as heartbeat-managed execution

The recovery model is intentionally conservative:

- preserve ownership
- retry once when the control plane lost execution continuity
- escalate visibly when the system cannot safely keep going

## 11. Practical Interpretation

For a board operator, the intended meaning is:

- agent-owned `in_progress` should mean \"this is live work or clearly surfaced as a problem\"
- agent-owned `todo` should not stay assigned forever after a crash with no remaining wake path
- parent/sub-issue explains structure
- blockers explain waiting

That is the execution contract Paperclip should present to operators.
