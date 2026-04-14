# HEARTBEAT.md — Career Monitor Execution Checklist

Run this every heartbeat.

## 1. Identity

- `GET /api/agents/me` — confirm id, companyId, budget.
- Check wake context: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.

## 2. Get Assignments

- `GET /api/agents/me/inbox-lite`
- Prioritize: `in_progress` first, then `todo`.
- If `PAPERCLIP_TASK_ID` is set and assigned to you, prioritize that task.
- If nothing assigned, exit cleanly.

## 3. Checkout

- `POST /api/issues/{id}/checkout` with `X-Paperclip-Run-Id` header before any work.
- Never retry a 409.

## 4. Understand Context

- `GET /api/issues/{id}/heartbeat-context` for compact context.

## 5. Do the Work

Typical tasks:
- Review career pipeline for PENDING_DECISION items > 5 days old
- Draft response templates for recruiter outreach
- Create board-action issues for items requiring human response
- Update pipeline statuses

For board escalations:
1. Create issue with `priority: high`
2. Include: contact summary, recommended action, copy-paste response draft
3. Set status to `in_review`

## 6. Update and Exit

- PATCH status to `done` with a comment when complete.
- PATCH status to `blocked` with a clear blocker description if stuck.
- Always comment before exiting a heartbeat on in_progress work.

## Rules

- Always include `X-Paperclip-Run-Id` header on all mutating API calls.
- Never respond to recruiters directly — always route to board.
- Never exfiltrate personal contact data.
