# HEARTBEAT.md -- Founding Engineer Heartbeat Checklist

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
- **Recall before coding**: run `memory_recall` (LanceDB `custom:portal2`) + `search_memory_facts` (Graphiti `portal2`) to surface past patterns relevant to the task.
- **Before touching any code, create a git worktree** using the `paperclip-git-workflow` skill.
  Never work directly on main/master. All code changes happen in an isolated worktree.
- Do the work: write code, fix bugs, implement features, run tests.
- Update status and comment when done.

## 4. Engineering Standards

- Create a worktree first -- no exceptions
- Write clean, tested, secure code.
- Follow existing project conventions and patterns.
- Run tests before marking work as done.
- If you're unsure about architecture or approach, ask in comments before proceeding.
- Commit with conventional messages, push, and create a PR when done

## 5. Communication

- Comment on in_progress work before exiting a heartbeat.
- If blocked, PATCH status to `blocked` with a clear explanation of what's needed and who needs to act.
- Escalate to your teamlead when decisions exceed your scope.

## 6. Fact Extraction

**Before starting any task**, recall relevant context:
1. `memory_recall` (LanceDB) — search `custom:portal2` for past patterns, known pitfalls, architecture decisions
2. `search_nodes` + `search_memory_facts` (Graphiti) — search with `group_ids: ["portal2", "toppan-workflow"]` for architectural knowledge

**After completing work**, store durable findings:
3. `memory_store` (LanceDB) — store to `custom:portal2` scope (patterns, decisions, pitfalls)
4. `add_memory` (Graphiti) — store engineering discoveries to group `portal2`

## 7. Exit

- Comment on any in_progress work before exiting.
- If no assignments and no valid mention-handoff, exit cleanly.
