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
  "expectedIdentifier": "TCN-1051",
  "status": "done",
  "comment": "Implemented caching with 90% hit rate."
}
```

The optional `comment` field adds a comment in the same call.
`expectedIdentifier` is an optional safety guard: when provided, the API returns **409 Conflict** if it does not match the issue at `{issueId}`.

Updatable fields: `title`, `description`, `status`, `priority`, `assigneeAgentId`, `projectId`, `goalId`, `parentId`, `billingCode`, `expectedIdentifier`.

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

**Cleared checkout on an `in_progress` assignee:** If `checkout_run_id` / `execution_run_id` drift out of sync while the issue stays `in_progress` for the same assignee (for example after process loss), heartbeat setup applies the **same repair semantics** as `POST …/checkout`: it may clear a stale `execution_run_id` when the stored run is no longer live, then **re-bind** `checkout_run_id` / `execution_run_id` to the coherent active run (including adopting the checkout run when `execution_run_id` is null but `checkout_run_id` still points at a **queued** / **running** run for this issue). Setup **does not** override a **different agent’s** live `execution_run_id`. Agents should still call checkout explicitly when moving from `todo`; this path avoids hard-failing setup when the row was left inconsistent.

**Leaving `in_progress`:** `PATCH` that sets a non-`in_progress` status, changes assignee, or `POST …/release` clears **`checkout_run_id`** and the execution-lock fields (**`execution_run_id`**, **`execution_agent_name_key`**, **`execution_locked_at`**) together so an issue in **`todo`** cannot retain a stale execution lock that would make checkout fail with **409**. If legacy rows still have a stale lock pointing at a **terminal** heartbeat run, **`POST …/checkout`** clears it once and retries the claim.

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

### Technical review outcome text (Portuguese and English)

The server’s non-blocking / approval detectors match **both English and Portuguese** review summaries. Example phrases the parser recognizes include **`pode seguir para revisão humana`**, **`pronto para revisão humana`**, and **`aprovado` / `aprovada` (for human review)** (accents optional). Blocking sections may use headers such as **`### Findings bloqueantes`** or **`### Blocking findings`**, with “no blockers” wording (e.g. **`nenhum`**, **`none`**). Handoff comments may carry an explicit PR head line such as **`Head: abc1234`**. Manual review tickets following the pattern **`Revisar PR #... de ...`** are reconciled with the same parent rules. If the closing summary **cannot be classified** (missing markers/phrases, too vague, or **ambiguous** mixed signals), the **parent issue is not auto-transitioned**; the server logs a warning and writes **`issue.review_outcome_unparsed`** on the review child for operator follow-up (see `doc/plans/2026-04-05-review-outcome-classification-matrix.md`). The bullets below refer to this behavior without repeating every localized example.

- legacy `in_review` rows are backfilled to `handoff_ready`
- `handoff_ready` is the executor-to-review handoff; direct `in_progress -> human_review` is not allowed
- **Automatic technical review dispatch** (when `PATCH` leaves the issue in `handoff_ready` **or** `technical_review`): the server resolves a **github.com** `…/pull/N` URL in this precedence (earlier steps win). Only **github.com** pull URLs are auto-parsed from text; other hosts need manual review tasks or operator mapping. This also acts as a self-heal path when a parent is already in `technical_review` but still missing a dispatched review child.
  1. **`comment` on that same `PATCH`** — if the request included a `comment` whose body contains a **`https://github.com/{owner}/{repo}/pull/{n}`** URL.
  2. **`pull_request` work product** on the issue — first row the server can resolve to a GitHub PR (work products are ordered **primary first**, then by **`updatedAt`** descending).
  3. **Recent issue comments** — the server loads the **20 most recent** comments (**newest first**). Among comments whose body contains a parseable **github.com** PR URL: prefer the **newest** comment whose body includes an **explicit handoff** (`# handoff` heading or `@revisor pr`) **or** declares **no new diff** (fixed Portuguese/English substring list in the dispatcher; distinct from [Technical review outcome text](#technical-review-outcome-text-portuguese-and-english) above). If none qualify, use the **newest** comment that only carries a GitHub PR URL.
  4. **Issue description** — first parseable **github.com** PR URL in the description.

  **`Head: abc1234`** (and similar head lines) in the chosen comment or description still refine diff identity when present.
- `claimed` and `in_progress` require an assignee
- entering `in_progress` from `todo` or `blocked` still requires checkout
- moving `claimed -> in_progress` is allowed after an explicit claim
- `started_at` auto-set on `in_progress`
- `completed_at` auto-set on `done`
- when a `technical_review_dispatch` child issue is completed with a blocking review summary, the source issue is auto-returned to `in_progress` for the assigned executor
- when a `technical_review_dispatch` child issue is completed without blocking findings, the source issue is auto-advanced to `human_review` **unless** the primary GitHub pull request on the parent is still **draft** (the parent stays in `technical_review` until the PR is ready for review)
- non-blocking outcomes are detected from the closing or latest review comment using the **Portuguese and English patterns** described in [Technical review outcome text](#technical-review-outcome-text-portuguese-and-english) above
- if the reviewer posts the summary comment first and only later closes the review child, Paperclip falls back to the latest review-summary comment to reconcile the source issue
- if the handoff comment explicitly carries the current PR head, the dispatcher treats that head SHA as the diff identity even when the pull-request work product is unavailable (see examples in that subsection)
- manual child issues that clearly follow the review-ticket pattern are reconciled with the same parent-state rules (see that subsection)
- updating a primary GitHub pull-request work product to `merged` (or `closed` with explicit merge metadata) auto-advances the source issue through any pending review states and marks it `done`
  - parent `done` plus cancellation of still-open technical-review children (`technical_review_dispatch` or legacy review title pattern) is applied in **one database transaction**; routine run sync and activity logging follow the commit (see [Runtime runbook](/guides/board-operator/runtime-runbook))
- **Direct merge eligible**
  - **Enable:** set the primary GitHub pull-request work product `metadata.directMergeEligible` to **`true`** using `POST /api/issues/{issueId}/work-products` or `PATCH /api/work-products/{id}`.
  - **When it fires:** the review child completes **approved**, and the parent issue reaches **`human_review`** with a **non-draft** PR.
  - **Effect:** the server enqueues a heartbeat wakeup for the **parent assignee** with **`mutation: "review_approved_merge_delegate"`** (see [Runtime runbook](/guides/board-operator/runtime-runbook)).
  - **GitHub automation:** include the HTML comment **`<!-- direct_merge_eligible -->`** in the PR description (case-insensitive match; see `.github/workflows/direct-merge-eligible.yml`), in addition to any API-side `metadata.directMergeEligible` you set via Paperclip.
- Terminal states: `done`, `cancelled`
