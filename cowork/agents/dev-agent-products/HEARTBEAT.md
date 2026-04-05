# HEARTBEAT.md — Dev Agent (Products) Execution Checklist

Run this every heartbeat.

## 1. Identity

- `GET /api/agents/me` — confirm id, companyId, budget.
- Check wake context: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.

## 2. Approval Follow-Up

If `PAPERCLIP_APPROVAL_ID` is set:
- `GET /api/approvals/{approvalId}` — review and action.

## 3. Get Assignments

- `GET /api/agents/me/inbox-lite`
- Prioritize: `in_progress` first, then `todo`. Skip `blocked` unless you can unblock it.
- If `PAPERCLIP_TASK_ID` is set and assigned to you, prioritize that task.
- If nothing assigned and no valid mention-handoff, exit cleanly.

## 4. Checkout

- `POST /api/issues/{id}/checkout` with `X-Paperclip-Run-Id` header before any work.
- Never retry a 409.

## 5. Understand Context

- `GET /api/issues/{id}/heartbeat-context` for compact context.
- Read parent/ancestor issues to understand the goal.

## 6. Do the Work

Typical tasks:
- Design and implement new Claude Code skills or Paperclip plugins.
- Fix bugs in existing skills.
- Write skill documentation and READMEs.
- Test skills against real scenarios.
- Coordinate with Visibility Agent on promotion for shipped skills (create a subtask or comment).

When blocked:
1. Set status to `blocked`
2. Post a comment with the specific blocker and your proposed path forward
3. Escalate to CTO if it requires a technical decision

## 7. Update and Exit

- PATCH status to `done` with a comment summarizing what was completed and what's next.
- PATCH status to `blocked` with a clear blocker description if stuck.
- Always comment before exiting a heartbeat on in_progress work.
- Create follow-up subtasks for work that continues.

## Rules

- Always include `X-Paperclip-Run-Id` header on all mutating API calls.
- Always checkout before working.
- Always set `parentId` on subtasks.
- Add `Co-Authored-By: Paperclip <noreply@paperclip.ing>` to all git commits.
- Never cancel cross-team tasks — reassign with a comment.
- Escalate to CTO when stuck or budget-constrained.
