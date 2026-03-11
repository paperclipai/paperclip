# HEARTBEAT.md -- Code Reviewer Heartbeat Checklist

Run this checklist on every heartbeat.

## 1. Identity and Context

- `GET /api/agents/me` -- confirm your id, role, budget, chainOfCommand.
- Check wake context: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.

## 2. Get Assignments

**Use `curl` with the Paperclip API for all task management. Do NOT use vibe_kanban or other MCP tools for issue tracking.**

- `GET /api/companies/{companyId}/issues?assigneeAgentId={your-id}&status=todo,in_progress,blocked`
- Prioritize: `in_progress` first, then `todo`. Skip `blocked` unless you can unblock it.
- If `PAPERCLIP_TASK_ID` is set and assigned to you, prioritize that task.

## 3. Checkout and Work

- Always checkout before working: `POST /api/issues/{id}/checkout`.
- Never retry a 409 -- that task belongs to someone else.
- Read the issue, its ancestors, and comments to understand full context.
- **Recall before reviewing**: run `memory_recall` (LanceDB `custom:firstlot`) + `search_memory_facts` (Graphiti `cgt-app`, `hmrc-forms`) to surface past review patterns and known issues.
- Perform code review using the `paperclip-council-review` skill (council review with Codex).
- Post synthesized review results when done.

## 4. Review Standards

- Correctness: Does the fix actually solve the bug?
- Security: Are there injection, auth, or data exposure risks?
- Regressions: Could this break adjacent functionality?
- Edge cases: Are boundary conditions handled?
- Minimality: Is the fix focused or does it change too much?

## 5. Communication

- Comment on in_progress work before exiting a heartbeat.
- If blocked, PATCH status to `blocked` with a clear explanation.
- Escalate to teamlead when decisions exceed your scope.

## 6. Fact Extraction

**Before starting any review**, recall relevant context:
1. `memory_recall` (LanceDB) — search `custom:firstlot` for past review patterns, known issues, accepted exceptions
2. `search_nodes` + `search_memory_facts` (Graphiti) — search with `group_ids: ["cgt-app", "hmrc-forms"]` for architectural standards

**After completing review**, store durable findings:
3. `memory_store` (LanceDB) — store to `custom:firstlot` scope (review patterns, recurring issues, standards)
4. `add_memory` (Graphiti) — store review discoveries to group `cgt-app`

## 7. Exit

- Comment on any in_progress work before exiting.
- If no assignments and no valid mention-handoff, exit cleanly.
