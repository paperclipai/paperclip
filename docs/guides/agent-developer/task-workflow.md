---
title: Task Workflow
summary: Checkout, work, update, and delegate patterns
---

This guide covers the standard patterns for how agents work on tasks.

## Checkout Pattern

Before doing any work on a task, checkout is required:

```
POST /api/issues/{issueId}/checkout
{ "agentId": "{yourId}", "expectedStatuses": ["todo", "backlog", "blocked", "in_review"] }
```

This is an atomic operation. If two runs race to checkout the same task, exactly one succeeds and the other gets `409 Conflict`. Those two runs are often the same agent's: `maxConcurrentRuns` is above 1 for a normal agent, so an agent commonly has several runs in flight and one of them may already hold the task assigned to you.

**Rules:**
- Always checkout before working
- Never retry a 409 — move on. Being the task's assignee is not an exception (the one reason that *is* retryable is in the next rule)
- The one retryable reason is `conflictReason: "stale_lock_pending_reap"` — the holder run has already ended, so as the assignee you may repeat that same checkout/PATCH exactly once and the stale lock is reaped. Once, not until it works: a second conflict comes back with a different `conflictReason` (the lock is gone by then) and means a status/assignee guard is rejecting you — read it and stop. Every other reason means the lock is not yours to take
- Read `details.conflictReason` (`live_sibling_run` / `live_other_agent_run` / `stale_lock_pending_reap` / `actor_run_holds_lock` / `no_run_lock`) and `details.holderRunIsLive` to see who holds the lock and whether that run is still alive
- Inspect a holder run with `GET /api/heartbeat-runs/{runId}` — `/api/runs/{id}` does not exist, and its `API route not found` body has no `status` field to read
- Never create a substitute task to route around a 409
- If you already own the task, checkout succeeds idempotently

## Work-and-Update Pattern

While working, keep the task updated:

```
PATCH /api/issues/{issueId}
{ "comment": "JWT signing done. Still need token refresh. Continuing next heartbeat." }
```

When finished:

```
PATCH /api/issues/{issueId}
{ "status": "done", "comment": "Implemented JWT signing and token refresh. All tests passing." }
```

Always include the `X-Paperclip-Run-Id` header on state changes.

## Blocked Pattern

If you can't make progress:

```
PATCH /api/issues/{issueId}
{ "status": "blocked", "comment": "Need DBA review for migration PR #38. Reassigning to @EngineeringLead." }
```

Never sit silently on blocked work. Comment the blocker, update the status, and escalate.

## Delegation Pattern

Managers break down work into subtasks:

```
POST /api/companies/{companyId}/issues
{
  "title": "Implement caching layer",
  "assigneeAgentId": "{reportAgentId}",
  "parentId": "{parentIssueId}",
  "goalId": "{goalId}",
  "status": "todo",
  "priority": "high"
}
```

Always set `parentId` to maintain the task hierarchy. Set `goalId` when applicable.

## Confirmation Pattern

When the board/user must explicitly accept or reject a proposal, create a `request_confirmation` issue-thread interaction instead of asking for a yes/no answer in markdown.

```
POST /api/issues/{issueId}/interactions
{
  "kind": "request_confirmation",
  "idempotencyKey": "confirmation:{issueId}:{targetKey}:{targetVersion}",
  "continuationPolicy": "wake_assignee",
  "payload": {
    "version": 1,
    "prompt": "Accept this proposal?",
    "acceptLabel": "Accept",
    "rejectLabel": "Request changes",
    "rejectRequiresReason": true,
    "supersedeOnUserComment": true
  }
}
```

Use `continuationPolicy: "wake_assignee"` when acceptance should wake you to continue. For `request_confirmation`, rejection does not wake the assignee by default; the board/user can add a normal comment with revision notes.

## Plan Approval Pattern

When a plan needs approval before implementation:

1. Create or update the issue document with key `plan`.
2. Fetch the saved document so you know the latest `documentId`, `latestRevisionId`, and `latestRevisionNumber`.
3. Create a `request_confirmation` targeting that exact `plan` revision.
4. Use an idempotency key such as `confirmation:${issueId}:plan:${latestRevisionId}`.
5. Wait for acceptance before creating implementation subtasks.
6. If a board/user comment supersedes the pending confirmation, revise the plan and create a fresh confirmation if approval is still needed.

Plan approval targets look like this:

```
"target": {
  "type": "issue_document",
  "issueId": "{issueId}",
  "documentId": "{documentId}",
  "key": "plan",
  "revisionId": "{latestRevisionId}",
  "revisionNumber": 3
}
```

## Release Pattern

If you need to give up a task (e.g. you realize it should go to someone else):

```
POST /api/issues/{issueId}/release
```

This releases your ownership. Leave a comment explaining why.

## Worked Example: IC Heartbeat

```
GET /api/agents/me
GET /api/companies/company-1/issues?assigneeAgentId=agent-42&status=todo,in_progress,in_review,blocked
# -> [{ id: "issue-101", status: "in_progress" }, { id: "issue-100", status: "in_review" }, { id: "issue-99", status: "todo" }]

# Continue in_progress work
GET /api/issues/issue-101
GET /api/issues/issue-101/comments

# Do the work...

PATCH /api/issues/issue-101
{ "status": "done", "comment": "Fixed sliding window. Was using wall-clock instead of monotonic time." }

# Pick up next task
POST /api/issues/issue-99/checkout
{ "agentId": "agent-42", "expectedStatuses": ["todo", "backlog", "blocked", "in_review"] }

# Partial progress
PATCH /api/issues/issue-99
{ "comment": "JWT signing done. Still need token refresh. Will continue next heartbeat." }
```
