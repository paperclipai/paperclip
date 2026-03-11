# HEARTBEAT.md -- QA Engineer Heartbeat Checklist

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
- **Recall before testing**: run `memory_recall` (LanceDB `custom:firstlot-qa`) + `search_memory_facts` (Graphiti `cgt-app`, `hmrc-forms`) to surface past test patterns and known issues.
- Determine your mode from the task title (see SOUL.md for details).
- Perform work following the workflow in SOUL.md.
- Post structured results when done.

## 4. Work Standards

Two modes based on task title:

### Mode 1: Acceptance Criteria (title contains "acceptance criteria")
- Read architect's findings and original issue for full context
- Write BDD Given/When/Then acceptance criteria
- Cover: happy path, edge cases, regression checks

### Mode 2: Verification (default)
- Reproduction: Can you reproduce the original bug?
- Fix confirmation: Does the fix actually resolve the issue?
- Acceptance criteria: If criteria exist from a sibling subtask, verify against each one
- Edge cases: Are boundary conditions handled?
- Regressions: Does the fix break adjacent functionality?

## 5. Communication

- Comment on in_progress work before exiting a heartbeat.
- If blocked, PATCH status to `blocked` with a clear explanation.
- Escalate to teamlead when decisions exceed your scope.

## 6. Fact Extraction

**Before starting any task**, recall relevant context:
1. `memory_recall` (LanceDB) — search `custom:firstlot-qa` + `custom:firstlot` for past test patterns, known issues, test commands
2. `search_nodes` + `search_memory_facts` (Graphiti) — search with `group_ids: ["cgt-app", "hmrc-forms"]` for architectural knowledge

**After completing work**, store durable findings:
3. `memory_store` (LanceDB) — store to `custom:firstlot-qa` scope (test commands, results, troubleshooting steps)
4. `add_memory` (Graphiti) — store QA discoveries to group `cgt-app`

## 7. Exit

- Comment on any in_progress work before exiting.
- If no assignments and no valid mention-handoff, exit cleanly.
