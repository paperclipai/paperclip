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
| `ids` | Filter to an explicit comma-separated set of issue ids |
| `projectId` | Filter by project |
| `sort` | Optional sort mode: `priority_then_activity` (default), `updated_desc`, or `last_activity_desc` |
| `limit` | Optional max row count |
| `includeReviewSignals` | Optional boolean. When `true`, list responses include `qaGate` and `mergeStatus` synthesis. Defaults to `false`. |
| `excludeRecoverySourcesWithOpenSuccessors` | Optional explicit filter. When `true`, hides blocked recovery-source issues that already have an open successor. The main Issues and Project board views opt into this. |

By default, results are sorted by priority and recent activity.

List responses also include:

- `boardState`: the server-computed board-facing state for the issue
- `primaryBlocker`: the highest-impact root blocker when the issue is dependency-blocked

When `includeReviewSignals=true`, list responses also include:

- `qaGate`: QA readiness snapshot for delivery-scoped issues
- `mergeStatus`: merge readiness/status snapshot when the issue is tied to an execution workspace branch flow

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
- `workflowInvalidatedAt`: timestamp used to mark stale workflow artifacts after an upstream handback/reopen
- `workflowSummary`: synthesized workflow state for root workflow issues
- `workflowArtifactStatus`: per-artifact readiness/staleness state for workflow lane issues

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

When an agent-authenticated create request omits `projectId`, the server inherits project scope from the current run context. It prefers the source issue's project when the run is issue-scoped, then falls back to the run snapshot's `projectId`.

For root issues, the server also resolves the effective delivery mode from project and company settings. If the resolved mode is `engineering`, the server auto-applies the built-in `engineering_delivery_v1` workflow during create. If the resolved mode is `simple`, the server creates a plain root issue.

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

Update responses may also include refreshed `boardState`, `primaryBlocker`, `qaGate`, `mergeStatus`, `workflowSummary`, and `workflowArtifactStatus` snapshots.

Recovery updates via the `recovery` field are board-only. Agent-authenticated callers must keep recovery on the same issue and escalate if a successor issue is truly required.

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

Fresh issue comments also drive automatic recovery heuristics. Explicit blocker, handoff, or wait-state truth in a recent comment suppresses operations recovery nudges for a cooldown window, but only when the comment uses structured markers rather than incidental prose. Supported examples include `Status: blocked`, `Blocked: ...`, `Handoff: ...`, `[BLOCKER]`, `[HANDOFF]`, `[QA ROUTE]`, `[READY FOR QA]`, `[AUTO-FIX BLOCKED]`, `[POISONED SESSION]`, `DONE: ...`, `Workflow gate: ...`, `Missing permission: ...`, and `Board action required.` PrivateClip also prefers the latest structured truth comment over newer ordinary chatter, and it ignores markers that only appear inside fenced code blocks or blockquotes.

When the current assignee agent comments on a non-workflow delivery-scoped issue in `in_progress` with clear QA handoff truth, PrivateClip can auto-route that issue into `in_review`. This currently recognizes `[READY FOR QA]`, `[AUTO-FIX READY FOR QA]`, and explicit completion truth such as `DONE:` comments, and it uses the same sole-eligible-QA auto-assignment rule as a manual `status: "in_review"` transition.

Workflow QA/Security comments behave differently. On workflow lane issues, failing QA review or verification comments, plus `[SECURITY FAIL]` / `[SECURITY BLOCKED]` comments, trigger a visible cross-lane handback instead of same-issue QA routing or same-issue auto-fix.

QA ship-verdict comments are enforced on write. When a delivery-scoped issue comment includes `[QA PASS]` or `[RELEASE CONFIRMED]`, the API rejects malformed verdicts with `422` unless the comment comes from the authorized release-gate QA owner and includes:

- the canonical Smart Review token line
- the canonical verification token line
- both `[QA PASS]` and `[RELEASE CONFIRMED]`

For gate synthesis and reconciliation, PrivateClip is more tolerant than the write-time validator. It evaluates the latest valid authorized QA verdict rather than blindly trusting the latest QA-authored comment, ignores transcript-only heartbeat/run chatter, ignores pass/release markers that only appear inside fenced code blocks or blockquotes, and accepts structured Smart Review prose or `DONE:`-style QA verdicts when they clearly include pass/release intent plus explicit verification evidence. Accepted tolerant forms include bold Markdown headings such as `**Smart Review Summary**` and explicit verification lines such as `TYPECHECK=pass`, `TESTS=pass`, `BUILD=pass`, and `SMOKE/NA=pass`.

The one-shot stuck-issue QA reconciliation flow only auto-closes non-workflow delivery issues. Workflow roots and workflow lanes still require their workflow artifact contracts, including the `qa-verdict` document where applicable.

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
- blocker relations are only active while the blocker issue is non-terminal; blockers in `done` or `cancelled` no longer count as blocking dependencies and can wake waiting dependents
- removing the last blocker from a blocked issue normalizes it out of `blocked` unless the same mutation explicitly sets another non-blocked status
- `in_progress` requires checkout (single assignee)
- `started_at` auto-set on `in_progress`
- `completed_at` auto-set on `done`
- Terminal states: `done`, `cancelled`

## Computed Board State

Issue routes can now return a board-facing explanation layer that the UI uses directly instead of guessing from raw status/comments:

- `boardState.kind`: `blocked | redirected | waiting | ready | done | system_error`
- `boardState.headline`: plain-language summary such as `Blocked by COMA-1098` or `Waiting on QA`
- `boardState.reasonCode`: `review | board_decision | assignee_followup | recovery | invalid_state | null`
- `boardState.primaryAction`: one explicit action target (`open_issue`, `open_blocker`, or `open_agent`)
- `primaryBlocker`: the root blocker surfaced for direct navigation
- `rootBlockers` / `blockerPath`: detail-route blocker graph context

Classification notes:

- recovery-source issues resolve to `boardState.kind = redirected` with `reasonCode = recovery`
- redirect headlines collapse recovery chains to the latest successor, for example `Superseded by COMA-1122`
- redirect actions open the successor issue directly instead of reopening the superseded source issue
- board issue lists can hide redirected recovery ancestors so only the canonical active successor remains in open-work views
- `system_error` / `invalid_state` is reserved for issues whose raw status is `blocked` but which have neither an active blocker relation nor an active recovery successor

## QA and Merge Metadata

When an issue participates in the delivery/QA flow, the API can surface:

- `qaGate.canShip` — whether the current QA requirements are satisfied
- `qaGate.missingRequirements` — unmet requirements such as not being in `in_review`, having no QA-authored comment yet, or missing pass/release confirmation on the latest valid QA verdict comment
- `qaGate.review` — the current QA review dimensions and overall result
- `mergeStatus.state` — `not_applicable`, `pending`, `ready`, `blocked`, or `merged`
- `mergeStatus.reason` — why merge is blocked or waiting
- `mergeStatus.targetBranch` / `sourceBranch` — the resolved branch pair when available

## Workflow Metadata

Workflow-enabled issues can also surface:

- `workflowInvalidatedAt` — when this workflow lane was last invalidated by an upstream reopen or review handback
- `workflowSummary.activeRoles` — workflow lanes that are actionable now on the root issue
- `workflowSummary.waitingRoles` — workflow lanes that exist but are still dependency-gated by active upstream blockers
- `workflowSummary.ownerNeededRoles` — actionable workflow lanes that still need an assigned owner
- `workflowSummary.lanes[].phase` — one of `missing`, `waiting`, `ready`, `active`, or `done`
- `workflowSummary.lanes[].blockedByRoles` — active upstream workflow blockers for a lane
- `workflowSummary.lanes[].ready` — compatibility boolean for “actionable now”
- `workflowArtifactStatus[].stale` — whether matching evidence exists but is older than `workflowInvalidatedAt`
- workflow root `blockingReasons` only include actionable blockers now; downstream waiting lanes do not contribute future artifact gaps until they become actionable
- workflow QA lanes use the same release-gate QA owner resolver as standalone delivery: configured company owner, then exactly one canonical `QA and Release Engineer`, then exactly one other eligible QA agent, otherwise explicit owner-blocked state
- workflow QA lanes use the latest valid authorized release-gate QA verdict comment, not a naive latest-comment check
- workflow QA lanes require a non-stale `qa-verdict` document plus a latest authorized QA verdict comment with:
  - full Smart Review summary
  - passing verification evidence (`TYPECHECK`, `TESTS`, `BUILD`, and `SMOKE`/`NA`)
  - QA pass / release-confirmed intent

For `engineering_delivery_v1`, the dependency graph is:

- `pm -> designer -> engineer`
- `engineer -> security`
- `engineer -> qa`

Only dependency-free lanes wake on template application. Downstream lanes start in `blocked`, then promote to `todo` when their final workflow blocker becomes terminal.
