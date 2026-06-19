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

**Guarded Project Done Transition Requirements:**
For projects subject to the Done Transition Guard (e.g., Dark Factory projects), marking an issue as `done` requires:

*Note: All required evidence (such as linking the PR work product or commenting with a waiver/gate-proof) must already be saved on the issue BEFORE sending the `status: done` update. If you include the PR link or waiver text only inside the final transition `comment` field, the transition will be rejected because guard validation runs before the new comment is saved.*
1. **Linked PR:** A linked implementation PR (either as a `pull_request` work product or mentioned in comments/description).
2. **PR Merged:** The PR must be merged (verified via the GitHub CLI).
3. **No Mistakes Gate Proof:** The PR's head commit must have passed the No Mistakes gate checks (producing a `PASS` verdict verified by the server).

If these conditions are not met, the transition will be blocked with `422 Unprocessable Entity` unless an approved human waiver comment (e.g., containing `"approved waiver"`), a run-manifest PR gate bypass (`taskRoute.prBacked: false` or `workOrder.gates.pr: false`), or a QA/report-only container exemption applies (meaning QA/audit/report-only title, description, or label without remediation/fix intent; for finding/evidence cards, this requires an explicit evidence-record/finding-record label or a short user-authored comment).

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
