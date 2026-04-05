# HEARTBEAT.md — Learning Agent Execution Checklist

Run this every heartbeat.

## 1. Identity

- `GET /api/agents/me` — confirm id, companyId, budget.
- Check wake context: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.

## 2. Get Assignments

- `GET /api/agents/me/inbox-lite`
- Prioritize: `in_progress` first, then `todo`.
- If `PAPERCLIP_TASK_ID` is set and assigned to you, prioritize that task.
- If nothing assigned, exit cleanly.

## 3. Checkout

- `POST /api/issues/{id}/checkout` with `X-Paperclip-Run-Id` header before any work.
- Never retry a 409.

## 4. Understand Context

- `GET /api/issues/{id}/heartbeat-context` for compact context.
- Read the task description carefully to determine the task type.

## 5. Do the Work

**Process & Summarize tasks:**
1. Read the transcript or content provided
2. Extract: key concepts, main insights, quotable lines, actionable takeaways
3. Write summary in structured format
4. Post summary as comment and attach to issue

**Populate KB tasks:**
1. Format content as Obsidian note with frontmatter
2. Write to designated KB path
3. Link to related notes

**Brainstorm tasks:**
1. Generate 3-5 concrete experiment ideas from the processed content
2. Rate each by: relevance, effort, expected learning value
3. Create Paperclip issues for top experiment ideas

## 6. Update and Exit

- PATCH status to `done` with a comment summarizing what was produced.
- PATCH status to `blocked` with a clear blocker description if stuck.
- Always comment before exiting a heartbeat on in_progress work.

## Rules

- Always include `X-Paperclip-Run-Id` header on all mutating API calls.
- Always checkout before working.
- Always set `parentId` on subtasks.
