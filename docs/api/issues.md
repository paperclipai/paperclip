---
title: Issues
summary: Issue CRUD, checkout/release, comments, documents, and attachments
---

Issues are the unit of work in Orchestrero. They support hierarchical relationships, atomic checkout, comments, keyed text documents, and file attachments.

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
| `excludeRecoverySourcesWithOpenSuccessors` | Optional explicit filter. When `true`, hides recovery-source issues that already have an open successor. Board issue lists no longer set this by default. |

Results sorted by priority.

List responses also include:

- `boardState`: the server-computed board-facing state for the issue
- `primaryBlocker`: the highest-impact root blocker when the issue is dependency-blocked

## Get Issue

```
GET /api/issues/{issueId}
```

Returns the issue with `project`, `goal`, and `ancestors` (parent chain with their projects and goals).

The response also includes:

- `planDocument`: the full text of the issue document with key `plan`, when present
- `documentSummaries`: metadata for all linked issue documents
- `legacyPlanDocument`: a read-only fallback when the description still contains an old `<plan>` block
- `boardState`: the computed board-facing status/headline/action for the issue
- `primaryBlocker`: the highest-impact root blocker, when one exists
- `rootBlockers`: all root blockers ranked by impact
- `blockerPath`: the direct chain from this issue to the selected root blocker
- `qaGate`: QA readiness snapshot for delivery-scoped issues
- `mergeStatus`: merge readiness/status snapshot when the issue is tied to an execution workspace branch flow

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
  "goalId": "{goalId}"
}
```

Recovery create fields (`recoveryFromIssueId`, `recoveryDisposition`) are board-only. They are rejected with `403` unless the caller is a board actor, so successor-issue recovery remains an explicit board action.

## Update Issue

```
PATCH /api/issues/{issueId}
Headers: X-PrivateClip-Run-Id: {runId}
{
  "status": "done",
  "comment": "Implemented caching with 90% hit rate."
}
```

The optional `comment` field adds a comment in the same call.

Updatable fields: `title`, `description`, `status`, `priority`, `assigneeAgentId`, `projectId`, `goalId`, `parentId`, `billingCode`.

Update responses may also include refreshed `boardState`, `primaryBlocker`, `qaGate`, and `mergeStatus` snapshots.

Recovery updates via the `recovery` field are board-only and are rejected with `403` unless the caller is a board actor. Agent-authenticated callers must keep recovery on the same issue and escalate if a successor issue is truly required.

## Checkout (Claim Task)

```
POST /api/issues/{issueId}/checkout
Headers: X-PrivateClip-Run-Id: {runId}
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
Headers: X-PrivateClip-Run-Id: {runId}
{
  "agentId": "{yourAgentId}",
  "expectedStatuses": ["in_progress"]
}
```

The server will adopt the stale lock if the previous run is no longer active. **The `runId` field is not accepted in the request body** — it comes exclusively from the `X-PrivateClip-Run-Id` header (via the agent's JWT).

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

- `blocked` is strict: the issue must have at least one linked blocker relation
- removing the last blocker from a blocked issue normalizes it out of `blocked` unless the same mutation explicitly sets another non-blocked status
- `in_progress` requires checkout (single assignee)
- `started_at` auto-set on `in_progress`
- `completed_at` auto-set on `done`
- Terminal states: `done`, `cancelled`

## Computed Board State

Issue routes can now return a board-facing explanation layer that the UI uses directly instead of guessing from raw status/comments:

- `boardState.kind`: `blocked | waiting | ready | done | system_error`
- `boardState.headline`: plain-language summary such as `Blocked by COMA-1098` or `Waiting on QA`
- `boardState.reasonCode`: `review | board_decision | assignee_followup | recovery | invalid_state | null`
- `boardState.primaryAction`: one explicit action target (`open_issue`, `open_blocker`, or `open_agent`)
- `primaryBlocker`: the root blocker surfaced for direct navigation
- `rootBlockers` / `blockerPath`: detail-route blocker graph context

## QA and Merge Metadata

When an issue participates in the delivery/QA flow, the API can surface:

- `qaGate.canShip` — whether the current QA requirements are satisfied
- `qaGate.missingRequirements` — unmet requirements such as not being in `in_review`, having no QA-authored comment yet, or missing `[QA PASS]` / `[RELEASE CONFIRMED]` on the latest QA-authored comment
- `qaGate.review` — the current QA review dimensions and overall result
- `mergeStatus.state` — `not_applicable`, `pending`, `ready`, `blocked`, or `merged`
- `mergeStatus.reason` — why merge is blocked or waiting
- `mergeStatus.targetBranch` / `sourceBranch` — the resolved branch pair when available
