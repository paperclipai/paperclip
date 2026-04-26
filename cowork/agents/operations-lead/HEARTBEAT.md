# HEARTBEAT.md — CEO Heartbeat Checklist

Run this checklist on every heartbeat.

## 1. Identity and Context

- `GET /api/agents/me` — confirm your id, role, budget, chainOfCommand.
- Check wake context: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.

## 2. Local Planning Check

1. Read today's plan from `$AGENT_HOME/memory/YYYY-MM-DD.md` under "## Today's Plan".
2. Review each planned item: what's completed, what's blocked, and what's up next.
3. For any blockers, resolve them yourself or escalate to the board.
4. If you're ahead, start on the next highest priority.
5. Record progress updates in the daily notes.

## 3. Approval Follow-Up

If `PAPERCLIP_APPROVAL_ID` is set:
- Review the approval and its linked issues.
- Close resolved issues or comment on what remains open.

## 4. Get Assignments

- Use `GET /api/agents/me/inbox-lite` (preferred compact form).
- Prioritize: `in_progress` first, then `todo`. Skip `blocked` unless you can unblock it.
- **Pre-checkout conflict check (critical):** Before attempting checkout, inspect the `activeRun` field from inbox-lite. If `activeRun` exists AND `activeRun.agentId` ≠ your agent ID, **skip this task entirely** — another agent has a lock and you will get a 409. Never retry 409s.
- If `PAPERCLIP_TASK_ID` is set and assigned to you, prioritize that task.

## 5. Checkout and Work

- Always checkout before working: `POST /api/issues/{id}/checkout`.
- Never retry a 409 — that task belongs to someone else.
- **Use Python scripts for all Paperclip API calls.**
- Do the work. Update status and comment when done.

## 6. Delegation

- Create subtasks with `POST /api/companies/{companyId}/issues`. Always set `parentId` and `goalId`.
- Use `paperclip-create-agent` skill when hiring new agents.
- Assign work to the right agent for the job.

## 7. Exit

- Comment on any in_progress work before exiting.
- If no assignments and no valid mention-handoff, exit cleanly.

## Rules

- Always use the Paperclip skill for coordination.
- Always include `X-Paperclip-Run-Id` header on mutating API calls.
- **Python-first for API calls.** Never use bash curl with `$PAPERCLIP_API_KEY` expansion.
- **Skip locked tasks.** If inbox-lite shows `activeRun.agentId` ≠ your id, do not attempt checkout.
- Self-assign via checkout only when explicitly @-mentioned.
