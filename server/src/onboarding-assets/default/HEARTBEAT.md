# HEARTBEAT.md -- Agent Heartbeat Checklist

Run this checklist on every heartbeat.

## 1. Identity and Context

- `GET /api/agents/me` -- confirm your id, role, budget, and chain of command.
- Check wake context: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.

## 2. Local Memory Check

1. Read today's note in `$AGENT_HOME/memory/YYYY-MM-DD.md`.
2. Review planned work, blockers, and what changed since the last run.
3. Record notable progress in today's note before exiting.

## 3. Get Assignments

- `GET /api/agents/me/inbox-lite`
- Prioritize `in_progress`, then `changes_requested` (rework after review), then `todo` / `claimed`.
- Skip `blocked` unless new context lets you unblock it.
- If `PAPERCLIP_TASK_ID` is set and assigned to you, prioritize it first.

## 4. Checkout and Work

- Always checkout before doing work: `POST /api/issues/{id}/checkout`
- Never retry a `409`.
- Do the work directly and keep the task moving.

## 5. Communicate

- Leave a concise comment on any `in_progress` work before exiting.
- If blocked, set the issue to `blocked` with a clear blocker comment.
- Reassign or escalate instead of letting work sit idle.

## 6. Direct merge delegate (executors)

When the server wakes you after **technical review approved** with payload `mutation: "review_approved_merge_delegate"` (often with `contextSnapshot.pullRequestUrl`, `pullRequestNumber`, `workProductId`):

1. Confirm the GitHub PR is **not draft** and is the one linked to the task.
2. Merge with the repo’s usual method (typically `gh pr merge <n> --squash` from the correct checkout). Skip this step if your operator uses **only** the GitHub Action `.github/workflows/direct-merge-eligible.yml` and the PR body already contains `direct_merge_eligible`—avoid racing two merge paths.
3. **`PATCH /api/work-products/{id}`** with `status: "merged"` and merge metadata so Paperclip can move the issue to `done` (see board docs / Issues API).
4. Leave a short comment on the issue with the merge result.

You do **not** need checkout for this path unless your tools require a local git checkout to run `gh`.

## 7. Memory Extraction

1. Add timeline updates to `$AGENT_HOME/memory/YYYY-MM-DD.md`.
2. Extract durable facts into `$AGENT_HOME/life/` when they matter beyond today.
3. Update `$AGENT_HOME/MEMORY.md` when you learn a stable working pattern.

## 8. Exit

- If nothing is assigned and no mention requires input, exit cleanly.
