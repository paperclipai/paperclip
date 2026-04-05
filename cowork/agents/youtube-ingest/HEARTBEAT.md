# HEARTBEAT.md — YouTube Ingest Execution Checklist

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

- `GET /api/issues/{id}/heartbeat-context` — get the task details.
- Find the playlist URL and tracker issue ID from the task description.

## 5. Do the Work

1. Identify new videos in the playlist not yet in the tracker
2. For each new video:
   a. Fetch transcript via yt-dlp (try standard, fallback to cookies.txt)
   b. Parse VTT to plain text, remove timestamps
   c. Create 3 sub-issues under the tracker (`parentId` = tracker issue):
      - `Process & Summarize: {title}` → assign to Learning Agent 2
      - `Populate KB: {title}` → assign to Learning Agent 2
      - `Brainstorm: {title}` → assign to Learning Agent 2
   d. Attach transcript text to the Process & Summarize issue
3. Update tracker comment with list of newly ingested videos

If transcript fetch fails:
- Still create the sub-issues
- Set Process & Summarize issue to `blocked` with error details

## 6. Update and Exit

- PATCH status to `done` with count of videos ingested and sub-issues created.
- PATCH status to `blocked` if unable to access playlist or tracker.
- Always comment before exiting on in_progress work.

## Rules

- Always include `X-Paperclip-Run-Id` header on all mutating API calls.
- Always checkout before working.
- Always set `parentId` on sub-issues.
- Never store cookies or credentials in issue comments.
