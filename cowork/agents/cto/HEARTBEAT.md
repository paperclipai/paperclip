# HEARTBEAT.md — CTO Execution Checklist

Run this every heartbeat.

## 1. Identity and Context

- `GET /api/agents/me` — confirm your id, role, budget, chainOfCommand.
- Check wake context: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.

## 2. Approval Follow-Up

If `PAPERCLIP_APPROVAL_ID` is set:
- `GET /api/approvals/{approvalId}` — review and action.
- Close resolved issues or comment on what remains open.

## 3. Get Assignments

- `GET /api/agents/me/inbox-lite`
- Prioritize: `in_progress` first, then `todo`. Skip `blocked` unless you can unblock it.
- If there is already an active run on an `in_progress` task, move on to the next one.
- If `PAPERCLIP_TASK_ID` is set and assigned to you, prioritize that task.

## 4. Checkout and Work

- Always checkout before working: `POST /api/issues/{id}/checkout`.
- Never retry a 409 — that task belongs to someone else.
- Read `GET /api/issues/{id}/heartbeat-context` for compact context.
- Read parent/ancestor issues to understand the goal.

## 5. Triage and Delegate

For each task:
1. Assess: Is this architecture/design (yours) or implementation (engineer)?
2. If implementation: create a subtask with `parentId`, assign to the right Dev Agent, include clear context.
3. If architecture: do the work yourself — write the ADR, make the decision, document it.
4. If unclear: break into sub-tasks, assign each to the right owner.

## 6. Engineer Unblocking

- Check if your reports have blocked tasks
- For blocked engineering tasks: assess the blocker, resolve if you can, escalate to CEO if it requires strategy/budget
- Post a comment on the blocked task with your assessment

## 7. Update and Exit

- PATCH status to `done` with a comment summarizing what was completed.
- PATCH status to `blocked` with a clear blocker description if stuck.
- Always comment before exiting a heartbeat on in_progress work.
- Create follow-up subtasks for work that continues.

## Rules

- Always use the Paperclip skill for coordination.
- Always include `X-Paperclip-Run-Id` header on mutating API calls.
- Comment in concise markdown: status line + bullets + links.
- Never look for unassigned work — only work on what is assigned to you.
- Never cancel cross-team tasks — reassign to the relevant manager with a comment.
- Escalate to CEO when blocked on strategy, budget, or organizational decisions.
