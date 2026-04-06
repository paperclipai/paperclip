# HEARTBEAT.md -- Agent Heartbeat Checklist

Run this checklist on every heartbeat.

## 1. Identity and Context

- `GET /api/agents/me` -- confirm your id, role, budget, and chain of command.
- Check wake context: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.

## 2. Local Memory Check

1. Read today's note in `$AGENT_HOME/memory/YYYY-MM-DD.md`.
2. Review planned work, blockers, and what changed since the last run.
3. Record notable progress in today's note before exiting.
4. If you will write/update today's memory note, re-read that exact file in the same session immediately before writing (OpenCode read-before-write guard).

## 3. Get Assignments

- `GET /api/agents/me/inbox-lite` — includes `handoff_ready` when you are still the assignee (typical when review dispatch nooped or the handoff metadata is incomplete).
- Prioritize `in_progress`, then **`handoff_ready`** (repair the handoff — section **3b**), then `changes_requested` (rework after review), then `todo` / `claimed`.
- Skip `blocked` unless new context lets you unblock it.
- If `PAPERCLIP_TASK_ID` is set and assigned to you, prioritize it first.
- Mandatory assigned-wake rule: when `PAPERCLIP_WAKE_REASON=issue_assigned` and `PAPERCLIP_TASK_ID` is set, execute that task first and do at least one concrete action on it before triaging unrelated assignments.

## 3b. Handoff ready / noop (review was not dispatched)

If **`handoff_ready`** appears in your **`inbox-lite`**, technical review may not have opened a child issue (**dispatch noop**: missing **github.com** PR URL, ambiguous reviewer, etc.).

- **Repair without “fake” execution:** prefer **`PATCH /api/issues/{id}`** with a **`comment`** whose body includes a valid **`https://github.com/{owner}/{repo}/pull/{n}`** URL and/or ensure an up-to-date **`pull_request` work product** — same rules as section **6a**. Confirm company **`technicalReviewerReference`** (or env / default reviewer) resolves to exactly one agent (board runbook).
- Do **not** checkout **`handoff_ready`** only to leave status noise; checkout is for returning to the execution lane when you actually need **`in_progress`**.
- Optional: board **`activity_log`** / events **`issue.review_dispatch_noop`** on that issue id explain the reason.

## 3c. Anti-stall scan (open stalled issues)

After you handle **`inbox-lite`**, if you still have time and budget: **`GET /api/companies/{companyId}/issues?assigneeAgentId={your-id}`** with a **`status`** filter covering your open work (for example `backlog,todo,claimed,in_progress,handoff_ready,blocked,changes_requested` — omit review lanes you must not bump without cause). Sort client-side by **`updatedAt` ascending** and touch the **oldest** rows first with a **short comment** or a legitimate status change.

- Do **not** checkout **`technical_review`** / **`human_review`** parents just to refresh **`updatedAt`** (runbook: leave a comment without reopening the execution lane when that is all you need).

## 4. Adapter / health after failed run

If your last heartbeat run **failed** (adapter error): before only retrying the same work, check for open **`agent_health_alert`** issues assigned to you (or escalated to your lead) and address environment/config findings — see board **Operational Observability** / health monitor behavior.

## 5. Checkout and Work

- Always checkout before doing work: `POST /api/issues/{id}/checkout`
- Never retry a `409`.
- Do the work directly and keep the task moving.

## 6. Communicate

- Leave a concise comment on any `in_progress` work before exiting.
- If blocked, set the issue to `blocked` with a clear blocker comment.
- Reassign or escalate instead of letting work sit idle.

## 6a. Technical review handoff (`handoff_ready`, executors)

When the PR is ready for **Revisor PR** (or the company’s `technicalReviewerReference` agent), move the issue to **`handoff_ready`** in a way the server can attach a GitHub PR to:

1. **Preferred:** keep the **`pull_request` work product** on the issue up to date (best diff identity for dispatch).
2. **Same `PATCH` as the status change:** include a **`comment`** whose body contains a **`https://github.com/{owner}/{repo}/pull/{n}`** URL. You do **not** need a `# Handoff` heading or `@revisor pr` for dispatch—the control plane uses that URL. Optional: add `Head: <sha>` in the comment for clearer dedup when the work product is missing.
3. If you already posted the URL in an earlier comment and only change status in a later PATCH, the server still scans **recent comments** (explicit handoff phrases win; otherwise the **newest** comment with a GitHub PR link) and then the issue **description**.

Only **github.com** PR URLs are auto-parsed; other hosts need manual review tasks or a work product the operator maps to GitHub.

## 7. Direct merge delegate (executors)

When the server wakes you after **technical review approved** with payload `mutation: "review_approved_merge_delegate"` (often with `contextSnapshot.pullRequestUrl`, `pullRequestNumber`, `workProductId`):

1. Confirm the GitHub PR is **not draft** and is the one linked to the task.
2. **Merge strategy (explicit runtime signal only—do not guess).** You **must** consult the configured **operator merge mode** from **one** documented runtime source for this deployment—**never** infer it from heuristics alone. **Do not** infer the strategy from the PR body, labels, branch names, CI status, or repository layout alone—those may correlate with `.github/workflows/direct-merge-eligible.yml` but are **not** a substitute for the configured signal. Use whichever single source your operator documents, for example:
   - Environment variable **`MERGE_STRATEGY`**
   - Operator API endpoint **`/operator/merge-strategy`** (e.g. **`GET /operator/merge-strategy`** if your deployment exposes it)
   - Agent context key **`"operator.mergeStrategy"`** (wake payload, task context, or company settings your operator documents)

   **After you resolve the strategy:**

   - **Skip your own `gh pr merge` (step 3) only when** the resolved strategy value is **exactly** `action-only` **and** the PR description contains the literal validation token **`direct_merge_eligible`** inside the marker your operator uses (e.g. HTML comment `<!-- direct_merge_eligible -->` that `.github/workflows/direct-merge-eligible.yml` matches). Treat the marker as **invalid** if the inner token is not exactly `direct_merge_eligible` (case and spelling per runbook)—in that case do **not** assume Action-only delegation; fall back to the safe default below.
   - If the strategy is **missing**, **unknown**, **invalid**, or **not documented for this deployment**, use a **safe fallback**: defer merge completion to the human/operator—**hybrid-safe** behavior is to **not** perform an automatic `gh pr merge` locally, avoiding a race with the GitHub Action **`.github/workflows/direct-merge-eligible.yml`** when you lack an explicit runtime merge-strategy signal. Prefer the same fallback whenever you cannot confidently resolve the configured source.
   - If the strategy is **known** and **not** `action-only`, follow the operator’s runbook for that value (often: you **do** run `gh pr merge` when you are the delegated executor).
3. **`gh pr merge` (GitHub merge execution; run only when step 2 authorizes you to merge locally):** use the repo’s usual method (typically `gh pr merge <n> --squash` from the correct checkout).
   - **Transient failures:** retry with **exponential backoff** (bounded attempts, capped total wait, increasing delay) on rate limits, network blips, timeouts, or GitHub **5xx**; **log each attempt** with error class and backoff interval.
   - **Deterministic failures:** **detect** merge conflicts, failing required checks, branch protection denials, and auth/permission errors; **stop retrying**, **log** with a stable **failure class** (e.g. `merge_conflict`, `checks_failed`, `permission_denied`), and **post an automatic PR comment** (required) with the failure summary and **required manual steps**, meeting the **messaging requirements** below. Then **escalate**: create or update a tracking issue and/or **notify on-call** per company playbook; cross-link that escalation in the PR and issue comments when applicable.
4. **`PATCH /api/work-products/{id}`** with `status: "merged"` and merge metadata so Paperclip can move the issue to `done` (see board docs / Issues API).
   - Apply **retry with exponential backoff** (bounded attempts) for transient HTTP/API errors (timeouts, connection resets, **429**, **502/503**). **Log** each failed attempt; after **exhausted retries** without success, treat as a failed PATCH for messaging and escalation (even if GitHub merge already succeeded—see below).
   - If **`PATCH` fails after a successful GitHub merge** (including after retries are exhausted), treat this as a **reconciliation incident**: append a **tombstone log entry** to today’s `$AGENT_HOME/memory/YYYY-MM-DD.md` (UTC timestamp, work product id, issue id, PR URL/number, merge evidence such as merge commit SHA or `gh` output, PATCH status/body/error), **notify the operator/on-call**, create a **compensating task** for manual reconciliation (align work product / issue on the board), and **comment on the issue** (and PR if helpful) per the **messaging requirements** below. State clearly that GitHub may already show the PR merged while Paperclip is out of sync until someone fixes it. Do not imply the board is updated until PATCH succeeds.
5. Leave a short comment on the issue with the merge result (success path), or on failure paths with failure class, links to the PR comment, escalation reference, and explicit **manual intervention** vs **rollback** guidance when applicable.

**Messaging requirements (all error comments—PR, issue, escalation):** Include **(1)** failure class and **UTC timestamp**, **(2)** identifiers: issue id, work product id, PR URL and number, **(3)** short **verbatim or summarized** error from `gh` or the API response, **(4)** **whether the PR was merged on GitHub** (yes/no/unknown), **(5)** **actionable manual steps** or pointer to the operator runbook, **(6)** that automatic merge or PATCH was **aborted** or **incomplete** as appropriate. **Manual intervention** triggers: any deterministic `gh pr merge` failure; any exhausted-retry PATCH failure; any ambiguity after partial success. **Rollback discussion** triggers: GitHub shows a merge (or you have merge evidence) but Paperclip was not updated—state that the operator may need to **reconcile the board** or, per policy, **revert the merge on GitHub**; do not silently recommend revert without aligning with operator governance.

You do **not** need checkout for this path unless your tools require a local git checkout to run `gh`.

## 8. Memory Extraction

1. Add timeline updates to `$AGENT_HOME/memory/YYYY-MM-DD.md`.
2. Extract durable facts into `$AGENT_HOME/life/` when they matter beyond today.
3. Update `$AGENT_HOME/MEMORY.md` when you learn a stable working pattern.
4. For OpenCode flows, never overwrite a memory file you did not read in this session; if the file changed since read, re-read and apply once.

## 8b. Missing files and paths

- Before reading/editing a repo file from memory or comments, confirm the path exists (`rg --files`, `find`, or equivalent).
- If a path is missing, treat it as context drift, not a fatal run condition: locate the new path and continue; only escalate when the target cannot be resolved.

## 9. Exit

- If nothing is assigned and no mention requires input, exit cleanly.
