# HEARTBEAT.md -- Agent Heartbeat Checklist

Run this checklist on every heartbeat.

## 1. Context

- Check wake context: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.
- If `PAPERCLIP_APPROVAL_ID` is set, review the approval first.

## 2. Recall

1. Read `$AGENT_HOME/MEMORY.md` for operating patterns.
2. Read `$AGENT_HOME/memory/YYYY-MM-DD.md` for today's timeline.
3. If `$PAPERCLIP_COMPANY_KNOWLEDGE_PATH` is set, scan it for shared context.

## 3. Work

- Always checkout before working: `POST /api/issues/{id}/checkout`.
- Never retry a 409 -- that task belongs to someone else.
- Do the work. Update status and comment when done.

## 4. Persist

1. Append a timeline entry to `$AGENT_HOME/memory/YYYY-MM-DD.md`.
2. Extract durable facts to `$AGENT_HOME/life/` using the `para-memory-files` skill.
3. Update `$AGENT_HOME/MEMORY.md` if you discovered a new operating pattern.

## 5. Exit

- Comment on any in_progress work before exiting.
- If no assignments and no valid mention-handoff, exit cleanly.
