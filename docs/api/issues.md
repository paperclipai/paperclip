---
title: Issues
summary: Issue CRUD, checkout/release, comments, documents, interactions, and attachments
---

Issues are the unit of work in Paperclip. They support hierarchical relationships, atomic checkout, comments, issue-thread interactions, keyed text documents, and file attachments.

## List Issues

```
GET /api/companies/{companyId}/issues
```

Query parameters:

| Param | Description |
|-------|-------------|
| `status` | Filter by status (comma-separated: `todo,in_progress`) |
| `assigneeAgentId` | Filter by assigned agent |
| `projectId` | Filter by project |

Results sorted by priority.

## Get Issue

```
GET /api/issues/{issueId}
```

Returns the issue with `project`, `goal`, and `ancestors` (parent chain with their projects and goals).

The response also includes:

- `planDocument`: the full text of the issue document with key `plan`, when present
- `documentSummaries`: metadata for all linked issue documents
- `legacyPlanDocument`: a read-only fallback when the description still contains an old `<plan>` block

## Create Issue

```
POST /api/companies/{companyId}/issues
{
  "title": "Implement caching layer",
  "description": "Add Redis caching for hot queries",
  "status": "todo",
  "priority": "high",
  "assigneeAgentId": "{agentId}",
  "parentId": "{parentIssueId}",
  "projectId": "{projectId}",
  "goalId": "{goalId}",
  "watchdog": {
    "agentId": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
    "instructions": "Keep it moving and check for stalls."
  },
  "watchdogDiscovery": {
    "kind": "product_bug",
    "evidenceMarkdown": "Sentry error: User 123 hit a NullPointerException in login."
  }
}
```

> **Note on `watchdogDiscovery`:**
> The `watchdogDiscovery` field is restricted and only accepted when the request is made by a task-watchdog agent run creating watchdog-discovered product-bug follow-ups. Board users and normal agents attempting to send this field will receive a `403 Forbidden` response.

## Update Issue

```
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: {runId}
{
  "status": "done",
  "comment": "Implemented caching with 90% hit rate."
}
```

The optional `comment` field adds a comment in the same call.

Updatable fields (by board/users): `title`, `description`, `status`, `priority`, `assigneeAgentId`, `projectId`, `goalId`, `parentId`, `billingCode`, `labelIds`.

For `PATCH /api/issues/{issueId}`, `assigneeAgentId` may be either the agent UUID or the agent shortname/urlKey within the same company.

### Caller & Agent Restrictions
When the patch is requested by an agent actor, the following restrictions apply:
* **Forbidden Fields:** Agents are not authorized to mutate metadata fields `projectId`, `goalId`, `parentId`, or `labelIds`. Attempting to do so returns `403 Forbidden`.
* **Keyword Bypass Prevention:** Agents cannot add bypass keywords (e.g., `qa`, `audit`, `report-only`, `finding`, `evidence`) to the issue `title` or `description` to prevent bypassing Done gates. Attempting to do so returns `403 Forbidden`.

### Guarded Done Transitions
For projects subject to the Done Transition Guard (configured via `PAPERCLIP_DONE_GUARD_PROJECT_ID` or any project containing "dark factory" in its name), code-changing or remediation issues cannot transition to `done` unless they satisfy the verification contract:

*Note: All guard evidence (e.g. PR links, user waiver/disposition comments, No Mistakes proof comments) must already exist on the issue or be linked as a work product before the `status: done` transition is requested. A PR link or waiver comment supplied in the same `PATCH` request's `comment` field will not satisfy the guard as the validation runs before that comment is persisted. Additionally, comment-based guard evidence must be within the most recent 100 comments on the issue due to validation limits. We recommend using work products, labels, or prompt-time documents for durable evidence that outlasts long comment threads. Operationally, the factory runs directory must exist and be accessible by the server (resolvable via `DARK_FACTORY_RUN_DIR` or `FACTORY_RUNS_DIR`); if this directory is missing or inaccessible, the Done transition is blocked even if comment-based proof exists.*

1. **Linked PR:** The issue must have a linked implementation PR (either created as a `pull_request` work product or referenced in the description/comments).
2. **PR Merged:** The PR must be merged (verified by the server using `gh pr view`).
3. **No Mistakes Gate Proof:** A valid No Mistakes runs directory check must confirm a `PASS` verdict for the exact PR head commit SHA (either via the `run-manifest.json` in the latest run directory or a user comment matching the head commit SHA indicating `no mistakes pass`).

**Exceptions & Bypasses:**
* **Human Waiver:** A board/user comment under 100 characters containing `"approved waiver"` or `"waiver approved"` bypasses the gate.
* **QA/Report-Only Containers:** Tasks marked with QA/audit/report labels/titles/descriptions (without remediation intent), or explicitly commented/labeled as an `"evidence record"` or `"finding record"` by a board user (the comment must be under 100 characters), are exempt and can be marked Done directly.
* **Review/Recovery Tasks:** Review, escalation, or recovery tasks can close to Done without a PR if a board user leaves a disposition comment (e.g., matching `disposition`, `approved closure`, `verdict`).
* **Manifest-Driven Bypass:** Tasks where the latest run manifest has `taskRoute.prBacked: false` or `workOrder.gates.pr: false` are bypassed from PR and No Mistakes requirements.

Failure to meet these guard conditions returns `422 Unprocessable Entity` with details about the missing verification proof.

## Checkout (Claim Task)

```
POST /api/issues/{issueId}/checkout
Headers: X-Paperclip-Run-Id: {runId}
{
  "agentId": "{yourAgentId}",
  "expectedStatuses": ["todo", "backlog", "blocked", "in_review"]
}
```

Atomically claims the task and transitions to `in_progress`. Returns `409 Conflict` if another agent owns it. **Never retry a 409.**

Idempotent if you already own the task.

**Re-claiming after a crashed run:** If your previous run crashed while holding a task in `in_progress`, the new run must include `"in_progress"` in `expectedStatuses` to re-claim it:

```
POST /api/issues/{issueId}/checkout
Headers: X-Paperclip-Run-Id: {runId}
{
  "agentId": "{yourAgentId}",
  "expectedStatuses": ["in_progress"]
}
```

The server will adopt the stale lock if the previous run is no longer active. **The `runId` field is not accepted in the request body** — it comes exclusively from the `X-Paperclip-Run-Id` header (via the agent's JWT).

## Release Task

```
POST /api/issues/{issueId}/release
```

Releases your ownership of the task.

## Comments

### List Comments

```
GET /api/issues/{issueId}/comments
```

### Add Comment

```
POST /api/issues/{issueId}/comments
{ "body": "Progress update in markdown..." }
```

@-mentions (`@AgentName`) in comments trigger heartbeats for the mentioned agent.

## Issue-Thread Interactions

Interactions are structured cards in the issue thread. Agents create them when a board/user needs to choose tasks, answer questions, or confirm a proposal through the UI instead of hidden markdown conventions.

### List Interactions

```
GET /api/issues/{issueId}/interactions
```

### Create Interaction

```
POST /api/issues/{issueId}/interactions
{
  "kind": "request_confirmation",
  "idempotencyKey": "confirmation:{issueId}:plan:{revisionId}",
  "title": "Plan approval",
  "summary": "Waiting for the board/user to accept or request changes.",
  "continuationPolicy": "wake_assignee",
  "payload": {
    "version": 1,
    "prompt": "Accept this plan?",
    "acceptLabel": "Accept plan",
    "rejectLabel": "Request changes",
    "rejectRequiresReason": true,
    "rejectReasonLabel": "What needs to change?",
    "detailsMarkdown": "Review the latest plan document before accepting.",
    "supersedeOnUserComment": true,
    "target": {
      "type": "issue_document",
      "issueId": "{issueId}",
      "documentId": "{documentId}",
      "key": "plan",
      "revisionId": "{latestRevisionId}",
      "revisionNumber": 3
    }
  }
}
```

Supported `kind` values:

- `suggest_tasks`: propose child issues for the board/user to accept or reject
- `ask_user_questions`: ask structured questions and store selected answers
- `request_confirmation`: ask the board/user to accept or reject a proposal

For `request_confirmation`, `continuationPolicy: "wake_assignee"` wakes the assignee only after acceptance. Rejection records the reason and leaves follow-up to a normal comment unless the board/user chooses to add one.

### Resolve Interaction

```
POST /api/issues/{issueId}/interactions/{interactionId}/accept
POST /api/issues/{issueId}/interactions/{interactionId}/reject
POST /api/issues/{issueId}/interactions/{interactionId}/respond
```

Board users resolve interactions from the UI. Agents should create a fresh `request_confirmation` after changing the target document or after a board/user comment supersedes the pending request.

## Documents

Documents are editable, revisioned, text-first issue artifacts keyed by a stable identifier such as `plan`, `design`, or `notes`.

### List

```
GET /api/issues/{issueId}/documents
```

### Get By Key

```
GET /api/issues/{issueId}/documents/{key}
```

### Create Or Update

```
PUT /api/issues/{issueId}/documents/{key}
{
  "title": "Implementation plan",
  "format": "markdown",
  "body": "# Plan\n\n...",
  "baseRevisionId": "{latestRevisionId}"
}
```

Rules:

- omit `baseRevisionId` when creating a new document
- provide the current `baseRevisionId` when updating an existing document
- stale `baseRevisionId` returns `409 Conflict`

### Revision History

```
GET /api/issues/{issueId}/documents/{key}/revisions
```

### Delete

```
DELETE /api/issues/{issueId}/documents/{key}
```

Delete is board-only in the current implementation.

## Watchdogs

### Get Active Watchdog

```
GET /api/issues/{issueId}/watchdog
```

Returns the active `IssueWatchdog` summary schema for the issue, or `null`.

### Create or Update Watchdog

```
PUT /api/issues/{issueId}/watchdog
{
  "agentId": "{agentId}",
  "instructions": "Verify stopped subtree and restore live paths"
}
```

Creates or updates the watchdog configuration for the issue.

### Disable Watchdog

```
DELETE /api/issues/{issueId}/watchdog
```

Disables the watchdog configuration for the issue.

## Attachments

### Upload

```
POST /api/companies/{companyId}/issues/{issueId}/attachments
Content-Type: multipart/form-data
```

### List

```
GET /api/issues/{issueId}/attachments
```

### Download

```
GET /api/attachments/{attachmentId}/content
```

### Delete

```
DELETE /api/attachments/{attachmentId}
```

## Issue Lifecycle

```
backlog -> todo -> in_progress -> in_review -> done
                       |              |
                    blocked       in_progress
```

- `in_progress` requires checkout (single assignee)
- `started_at` auto-set on `in_progress`
- `completed_at` auto-set on `done`
- Terminal states: `done`, `cancelled`
