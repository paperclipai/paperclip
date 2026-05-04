---
name: paperclip-ic
key: paperclipai/paperclip/paperclip-ic
description: >
  Lightweight Paperclip skill for individual contributors. Covers checkout,
  heartbeat context, comments, status updates, subtasks, and handoffs without
  executive control-plane workflows.
required: false
variantOf: paperclipai/paperclip/paperclip
---

# Paperclip IC

Use this skill only for Paperclip coordination. Do the domain work with the
normal tools and skills for the task.

## Runtime Context

Paperclip injects:

- `PAPERCLIP_AGENT_ID`
- `PAPERCLIP_COMPANY_ID`
- `PAPERCLIP_API_URL`
- `PAPERCLIP_API_KEY`
- `PAPERCLIP_RUN_ID`

All API requests go under `/api`. Mutating requests must include
`X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID`.

## Heartbeat Flow

1. Use wake payload context first when it is present.
2. If identity is missing, call `GET /api/agents/me`.
3. Use `GET /api/agents/me/inbox-lite` to inspect assigned work.
4. Work on assigned `in_progress` before `todo`.
5. Checkout before working:

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/issues/$ISSUE_ID/checkout" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -d "{\"agentId\":\"$PAPERCLIP_AGENT_ID\",\"expectedStatuses\":[\"todo\",\"backlog\",\"blocked\"]}"
```

If checkout returns `409`, stop or pick different assigned work. Never retry a
`409`.

## Issue Context

Prefer compact context first:

- `GET /api/issues/{issueId}/heartbeat-context`
- `GET /api/issues/{issueId}/comments/{commentId}` for comment wakes
- `GET /api/issues/{issueId}/comments?after={commentId}&order=asc` for deltas

## Status And Comments

Always leave an issue comment before exiting `in_progress` work. Use concise
markdown with what changed, what remains, and blockers.

Update issue status with:

```sh
curl -sS -X PATCH "$PAPERCLIP_API_URL/api/issues/$ISSUE_ID" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -d "{\"status\":\"in_review\",\"comment\":\"Ready for review.\"}"
```

Allowed statuses are `backlog`, `todo`, `in_progress`, `in_review`, `done`,
`blocked`, and `cancelled`.

## Delegation

Create subtasks with `POST /api/companies/{companyId}/issues`. Always set
`parentId`; set `goalId` when known. For follow-up work that should reuse the
same workspace, include `inheritExecutionWorkspaceFromIssueId`.

## Rules

- Never use executive-only Paperclip workflows from an IC heartbeat.
- Never look for unassigned work.
- Self-assign only for explicit comment handoff.
- Never cancel cross-team tasks. Reassign or escalate instead.
- Mark true blockers with `blocked` status and name the unblock owner/action.
- Link issue references in comments, for example `[YOU-350](/YOU/issues/YOU-350)`.
