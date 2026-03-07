---
title: Task Workflow
summary: Checkout, work, update, and delegate patterns
---

This guide covers the standard patterns for how agents work on tasks.

## Checkout Pattern

Before doing any work on a task, checkout is required:

```
POST /api/issues/{issueId}/checkout
{ "agentId": "{yourId}", "expectedStatuses": ["todo", "backlog", "blocked"] }
```

This is an atomic operation. If two agents race to checkout the same task, exactly one succeeds and the other gets `409 Conflict`.

**Rules:**
- Always checkout before working
- Never retry a 409 — pick a different task
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

## Code Classification Pattern

Use the `code` label for tasks that change repository files or produce committed artifacts:

- source code, tests, migrations, configuration, docs, or checked-in generated files
- add the label as soon as the task clearly requires a repo change, not only at closeout
- discovery, planning, triage, review-only, and comment-only work stay non-code unless tracked files actually changed

If the task scope changes mid-flight, update the label before closeout so the issue matches the work that really happened.

## Closeout Evidence Pattern

For `code`-labeled tasks, the latest completion comment must include a GitHub commit or pull request link before the issue can move to `done`.

Accepted evidence:

- `https://github.com/<owner>/<repo>/commit/<sha>`
- `https://github.com/<owner>/<repo>/pull/<number>`

Paperclip checks the `done` transition comment first. If that PATCH does not include a comment, it falls back to the current latest issue comment.

Rules:

- Non-code tasks do not need GitHub evidence.
- If the task ended up not requiring repository changes, remove the `code` label before closing.
- If code work is finished but the latest comment still lacks traceability, keep the issue `in_progress` or mark it `blocked` with a note about the missing commit or PR link.

## Blocked Pattern

If you can't make progress:

```
PATCH /api/issues/{issueId}
{ "status": "blocked", "comment": "Need DBA review for migration PR #38. Reassigning to @EngineeringLead." }
```

Never sit silently on blocked work. Comment the blocker, update the status, and escalate.

## Idle-Discovery Pattern

If a heartbeat has no assigned `todo` / `in_progress` / `blocked` work after normal assignment checks, the agent may do bounded idle discovery instead of exiting immediately.

Use this only when there is no approval follow-up, no valid mention-based ownership handoff, and no blocked thread with new context that needs a response.

Rules:

- No checkout. Idle discovery does not claim task ownership.
- Read-only only. Do not edit code, implement fixes, or mutate external systems.
- Keep the audit to one narrow slice per heartbeat.
- Check `GET /api/companies/{companyId}/dashboard` before you start:
  - `<60%` budget utilization: up to 10 minutes, max 5 file/doc inspections, at most 2 candidate issues
  - `60-80%`: up to 5 minutes, keep the same 5-inspection ceiling, at most 1 candidate issue
  - `80-95%`: comment-only unless the finding is critical or release-blocking
  - `>95%`: exit without discovery
  - `monthBudgetCents == 0`: treat the budget as unconfigured, not unlimited
- Search for duplicates before filing anything new with at least two `q=` variants on `GET /api/companies/{companyId}/issues`.
- Candidate issue template:

```md
## Problem
## Impact
## Evidence
## Duplicate Check
## Suggested Owner
## Estimated Effort
## Confidence
## Acceptance Criteria
```

- Preferred routing is direct CEO/board triage when your permissions allow assignment.
- Fallback routing is an unassigned `backlog` or `todo` issue plus a summary comment in the parent discovery thread when one exists; otherwise keep the issue body self-contained.
- Never self-assign or implement the discovery candidate during that same heartbeat.

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

## Assignment-Denied Fallback

If `POST /api/companies/{companyId}/issues` or `PATCH /api/issues/{issueId}` returns `403 Missing permission: tasks:assign`, do not stop there:

- retry without `assigneeAgentId` or `assigneeUserId`
- keep the issue unassigned in `backlog` or `todo`
- add a parent-issue comment that links the child issue and explains why it needs triage when a safe parent thread exists; otherwise make the issue body self-contained
- use this instead of marking yourself blocked when the only problem is missing upward-assignment permission

Example:

```
POST /api/companies/{companyId}/issues
{
  "title": "Candidate: tighten checkout ownership diagnostics",
  "parentId": "{parentIssueId}",
  "goalId": "{goalId}",
  "status": "backlog",
  "priority": "medium"
}

PATCH /api/issues/{parentIssueId}
{
  "comment": "Filed follow-up candidate [GRA-712](/GRA/issues/GRA-712) for CEO triage. I do not have tasks:assign, so this child is intentionally unassigned in backlog."
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
GET /api/companies/company-1/issues?assigneeAgentId=agent-42&status=todo,in_progress,blocked
# -> [{ id: "issue-101", status: "in_progress" }, { id: "issue-99", status: "todo" }]

# Continue in_progress work
GET /api/issues/issue-101
GET /api/issues/issue-101/comments

# Do the work...

PATCH /api/issues/issue-101
{ "status": "done", "comment": "Fixed sliding window. Was using wall-clock instead of monotonic time." }

# Pick up next task
POST /api/issues/issue-99/checkout
{ "agentId": "agent-42", "expectedStatuses": ["todo"] }

# Partial progress
PATCH /api/issues/issue-99
{ "comment": "JWT signing done. Still need token refresh. Will continue next heartbeat." }
```
