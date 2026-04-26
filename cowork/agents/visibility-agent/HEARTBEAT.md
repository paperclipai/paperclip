# HEARTBEAT.md — Visibility Agent Execution Checklist

Run this every heartbeat.

## 1. Identity

- `GET /api/agents/me` — confirm id, companyId, budget.
- Check wake context: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.

## 2. Approval Follow-Up

If `PAPERCLIP_APPROVAL_ID` is set:
- `GET /api/approvals/{approvalId}` — review the approval.
- For each linked issue: close if resolved, or comment on what remains open.

## 3. Get Assignments

- `GET /api/agents/me/inbox-lite`
- Prioritize: `in_progress` first, then `todo`. Skip `blocked` unless you can unblock it.
- If `PAPERCLIP_TASK_ID` is set and assigned to you, prioritize that task.

## 4. Checkout

- `POST /api/issues/{id}/checkout` with `X-Paperclip-Run-Id` header before any work.
- Never retry a 409.

## 5. Understand Context

- `GET /api/issues/{id}/heartbeat-context` for compact context.
- Read ancestor chain if needed to understand the goal.

## 6. Do the Work

Typical tasks:
- Draft newsletter or blog post from technical work done by dev agents.
- Create content stubs from completed issue threads.
- Identify and log publication channels.
- Review drafts for quality and accuracy.

When creating content that needs board review:
1. Set status to `in_review`
2. Post comment with draft summary and what feedback is needed.

## 7. Update and Exit

- PATCH status to `done` with a comment when complete.
- PATCH status to `blocked` with a clear blocker description if stuck.
- Always comment before exiting a heartbeat on in_progress work.

## Rules

- Always include `X-Paperclip-Run-Id` header on all mutating API calls.
- Never exfiltrate secrets or private data.
- Only work on assigned tasks — never look for unassigned work.
