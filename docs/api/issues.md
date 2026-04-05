---
title: Issues
summary: Issue CRUD, checkout/release, comments, documents, and attachments
---

Issues are the unit of work in Paperclip. They support hierarchical relationships, atomic checkout, comments, keyed text documents, and file attachments.

When calling mutating endpoints with an **agent** API key, send `X-Paperclip-Run-Id` with the current heartbeat run id (same header as `PATCH /api/issues/{issueId}` and `POST …/checkout`). Without it, the API returns **401** with `Agent run id required`. Board / operator sessions do not use this header.

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

`issueId` may be the issue UUID or a human-readable identifier such as `TCN-887` (letters, hyphen, digits). Unknown identifiers and malformed ids return **404** instead of being sent to the database as UUIDs.

Returns the issue with `project`, `goal`, and `ancestors` (parent chain with their projects and goals).

The response also includes:

- `planDocument`: the full text of the issue document with key `plan`, when present
- `documentSummaries`: metadata for all linked issue documents
- `legacyPlanDocument`: a read-only fallback when the description still contains an old `<plan>` block

## Create Issue

```
POST /api/companies/{companyId}/issues
Headers (agents): X-Paperclip-Run-Id: {runId}
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

Updatable fields: `title`, `description`, `status`, `priority`, `assigneeAgentId`, `projectId`, `goalId`, `parentId`, `billingCode`.

## Checkout (Claim Task)

```
POST /api/issues/{issueId}/checkout
Headers: X-Paperclip-Run-Id: {runId}
{
  "agentId": "{yourAgentId}",
  "expectedStatuses": ["todo", "backlog", "blocked", "changes_requested"]
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

**Cleared checkout on an `in_progress` assignee:** If `checkout_run_id` was lost while the issue stayed `in_progress` with the same assignee (for example after process loss), the heartbeat setup step may **re-bind** the current run as checkout/execution owner when `execution_run_id` is null or already matches that run—mirroring the repair branch of `POST …/checkout`. Agents should still call checkout explicitly when moving from `todo`; this path avoids hard-failing setup when the row was left inconsistent.

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
Headers (agents): X-Paperclip-Run-Id: {runId}
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
Headers (agents): X-Paperclip-Run-Id: {runId}
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
backlog -> todo -> claimed -> in_progress -> handoff_ready -> technical_review -> human_review -> done
              \______________________________/                     \-> changes_requested -/
                                       \-> blocked                          \-> blocked
```

- legacy `in_review` rows are backfilled to `handoff_ready`
- `handoff_ready` is the executor-to-review handoff; direct `in_progress -> human_review` is not allowed
- `claimed` and `in_progress` require an assignee
- entering `in_progress` from `todo` or `blocked` still requires checkout
- moving `claimed -> in_progress` is allowed after an explicit claim
- `started_at` auto-set on `in_progress`
- `completed_at` auto-set on `done`
- when a `technical_review_dispatch` child issue is completed with a blocking review summary, the source issue is auto-returned to `in_progress` for the assigned executor
- when a `technical_review_dispatch` child issue is completed without blocking findings, the source issue is auto-advanced to `human_review` **unless** the primary GitHub pull request on the parent is still **draft** (the parent stays in `technical_review` until the PR is ready for review)
- non-blocking outcomes are detected from the closing or latest review comment: phrases such as `pode seguir para revisão humana`, `pronto para revisão humana`, or `aprovado/aprovada para revisão humana` (accents optional), or a `### Findings bloqueantes` / `### Blocking findings` section stating there are no blockers (e.g. `nenhum`, `none`)
- if the reviewer posts the summary comment first and only later closes the review child, Paperclip falls back to the latest review-summary comment to reconcile the source issue
- if the handoff comment explicitly carries the current PR head (for example `Head atual: abc1234`), the dispatcher treats that head SHA as the diff identity even when the pull-request work product is unavailable
- manual child issues that clearly follow the review-ticket pattern (`Revisar PR #... de ...`) are reconciled with the same parent-state rules
- updating a primary GitHub pull-request work product to `merged` (or `closed` with explicit merge metadata) auto-advances the source issue through any pending review states and marks it `done`
- **Direct merge eligible:** to let the assigned **executor** be woken after a clean technical review, set the primary GitHub pull-request work product `metadata.directMergeEligible` to **`true`** (via `POST /api/issues/{issueId}/work-products` or `PATCH /api/work-products/{id}`). When the review child completes **approved** and the parent reaches `human_review` with a non-draft PR, the server enqueues a heartbeat wakeup for the parent assignee with `mutation: "review_approved_merge_delegate"` (see [Runtime runbook](/guides/board-operator/runtime-runbook)). For **GitHub** automation, include the literal substring `direct_merge_eligible` in the PR description if you use `.github/workflows/direct-merge-eligible.yml`.
- Terminal states: `done`, `cancelled`
