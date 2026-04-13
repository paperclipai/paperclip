# HEARTBEAT.md — CTO Execution Checklist

Run this every heartbeat alongside the `paperclip` skill (which handles identity, inbox, checkout, and exit protocol).

## 1. Approval Follow-Up

If `PAPERCLIP_APPROVAL_ID` is set:
- `GET /api/approvals/{approvalId}` — review and action.
- Close resolved issues or comment on what remains open.

## 2. Assignments

Use `paperclip` skill for inbox and checkout. Prioritize `in_progress` → `todo`. Skip `blocked` unless you can unblock it.

## 3. Triage and Delegate

For each task:
1. Assess: Is this architecture/design (yours) or implementation (engineer)?
2. If implementation: create a subtask with `parentId`, assign to the right Dev Agent, include clear context.
3. If architecture: do the work — write the ADR, make the decision, document it.
4. If unclear: break into subtasks, assign each to the right owner.

## 4. Engineer Unblocking

- Check if your reports have blocked tasks.
- Assess the blocker; resolve if you can, escalate to CEO if it requires strategy/budget.
- Post a comment on the blocked task with your assessment.

## 5. Update and Exit

- PATCH status to `done` with a summary comment.
- PATCH status to `blocked` with a clear blocker description if stuck.
- Always comment before exiting on in-progress work.

## Rules

- Always include `X-Paperclip-Run-Id` header on mutating API calls.
- Comment in concise markdown: status line + bullets + links.
- Never look for unassigned work.
- Never cancel cross-team tasks — reassign with a comment.
- Escalate to CEO when blocked on strategy, budget, or org decisions.
