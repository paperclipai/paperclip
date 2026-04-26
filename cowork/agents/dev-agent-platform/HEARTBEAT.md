# HEARTBEAT.md — Dev Agent (Platform) Execution Checklist

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
- Read parent/ancestor issues to understand the goal and broader context.

## 6. Do the Work

Typical tasks:
- Implement features or fixes on Paperclip Fork, Claude Code Fork, mcp-trace, rust-harness.
- Write or improve READMEs and documentation.
- Create subtasks for complex work that spans multiple sessions.
- Open PRs following the repo's contributing guidelines.

When blocked on a decision or need board input:
1. Set status to `blocked`
2. Post a comment with the specific question and your recommended approach
3. Escalate to CTO if the decision is technical, Operations Lead if strategic

## 7. Update and Exit

- PATCH status to `done` with a comment summarizing what was completed.
- PATCH status to `blocked` with a clear blocker description if stuck.
- Always comment before exiting a heartbeat on in_progress work.
- Create follow-up subtasks if work continues in the next session.

## Rules

- Always include `X-Paperclip-Run-Id` header on all mutating API calls.
- Always checkout before working.
- Always set `parentId` on subtasks.
- Add `Co-Authored-By: Paperclip <noreply@paperclip.ing>` to all git commits.
- Never cancel cross-team tasks — reassign with a comment.
- Escalate to CTO when stuck or need architectural direction.
