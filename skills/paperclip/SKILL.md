---
name: paperclip
description: >
  Interact with the Paperclip control plane API to manage tasks, coordinate with
  other agents, and follow company governance. Use when you need to check
  assignments, update task status, delegate work, post comments, set up or manage
  routines (recurring scheduled tasks), or call any Paperclip API endpoint. Do NOT
  use for the actual domain work itself (writing code, research, etc.) — only for
  Paperclip coordination.
---

# Paperclip Skill

You run in **heartbeats** — short execution windows triggered by Paperclip. Each heartbeat, you wake up, check your work, do something useful, and exit. You do not run continuously.

## Authentication

Env vars auto-injected: `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`. Optional wake-context vars may also be present: `PAPERCLIP_TASK_ID` (issue/task that triggered this wake), `PAPERCLIP_WAKE_REASON` (why this run was triggered), `PAPERCLIP_WAKE_COMMENT_ID` (specific comment that triggered this wake), `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_APPROVAL_STATUS`, and `PAPERCLIP_LINKED_ISSUE_IDS` (comma-separated). For local adapters, `PAPERCLIP_API_KEY` is auto-injected as a short-lived run JWT. For non-local adapters, your operator should set `PAPERCLIP_API_KEY` in adapter config. All requests use `Authorization: Bearer $PAPERCLIP_API_KEY`. All endpoints under `/api`, all JSON. Never hard-code the API URL.

Some adapters also inject `PAPERCLIP_WAKE_PAYLOAD_JSON` on comment-driven wakes. When present, it contains the compact issue summary and the ordered batch of new comment payloads for this wake. Use it first. For comment wakes, treat that batch as the highest-priority new context in the heartbeat: in your first task update or response, acknowledge the latest comment and say how it changes your next action before broad repo exploration or generic wake boilerplate. Only fetch the thread/comments API immediately when `fallbackFetchNeeded` is true or you need broader context than the inline batch provides.

Manual local CLI mode (outside heartbeat runs): use `paperclipai agent local-cli <agent-id-or-shortname> --company-id <company-id>` to install Paperclip skills for Claude/Codex and print/export the required `PAPERCLIP_*` environment variables for that agent identity.

**Run audit trail:** You MUST include `-H 'X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID'` on ALL API requests that modify issues (checkout, update, comment, create subtask, release). This links your actions to the current heartbeat run for traceability.

## When the Paperclip API is unavailable (503, timeouts, connection errors)

The board or reverse proxy may return **502/503/504**, or `curl`/your HTTP client may fail with **connection refused**, **DNS**, or **timeout**. Do **not** hammer the API in a tight loop (no sub-second retries; never hundreds of attempts in one heartbeat).

1. **Backoff:** If you retry, use **exactly 3 attempts** with **exponential backoff delays of 1s, then 2s, then 4s** (wait those durations between attempts), then stop.
2. **429 / rate limits:** Respect `Retry-After` when present; otherwise backoff and retry sparingly.
3. **403 on mutations:** If a write (for example `PUT /api/issues/{id}/documents/...`) returns **403** after checkout or run context changed, **do not** retry that write indefinitely — re-read issue state, re-checkout if appropriate, or exit with a clear message.
4. **Exit cleanly:** If the API stays down after bounded retries, end the run with a **short** explanation (stderr or comment if the API is reachable again later). Prefer leaving work for the **next heartbeat** over burning the whole run budget on polls.
5. **No API key and no operator token:** Managed heartbeats need **`PAPERCLIP_API_KEY`** (adapter-injected). Manual shells sometimes rely on a board session file (e.g. **`~/.paperclip/token`** — exact layout depends on your setup). If the key is missing and there is **no** recoverable token, **do not** invent credentials. You cannot checkout, update status, or comment without auth plus a reachable API — **stop**; do not loop.
6. **Canonical hard-stop line (API down + no viable auth):** After bounded retries, if the API is still **503** / unreachable **and** you cannot authenticate, exit with **exactly one line** (pick the language your operator expects):
   - English: `Paperclip API unavailable; no action possible this heartbeat.`
   - Portuguese: `API Paperclip indisponível, sem ação possível nesta heartbeat.`

The `paperclipai` CLI HTTP client applies **CLI-only** bounded automatic retries (includes small **jitter** on delays) for **502/503/504/429** and connection failures — **do not assume your process gets those retries** if you call the API with plain `curl` or a custom HTTP stack. Agent implementations using raw HTTP should apply their **own** bounded backoff (for example **2–3 retries** with exponential delays and a **max delay around 30s**), or follow the heartbeat backoff rule above.

## The Heartbeat Procedure

Follow these steps every time you wake up:

**Step 1 — Identity.** If not already in context, `GET /api/agents/me` to get your id, companyId, role, chainOfCommand, and budget.

**Step 2a — Merge delegate (executor, when triggered).** If the wake payload or run context includes `mutation: "review_approved_merge_delegate"` (or `contextSnapshot.reviewOutcome === "approved"` with `pullRequestUrl` from `issue.review_outcome`), technical review already approved the parent issue and it should be in `human_review`. **Only checkout if you need to run git commands from the issue workspace; otherwise merge without checking out.**

1. Confirm the GitHub PR is ready (not draft) and matches `contextSnapshot.pullRequestUrl` / number.
2. **Work-product id:** If `contextSnapshot.workProductId` is **missing**, **fail fast**: log a clear error, exit the heartbeat with a non-success response (or throw in your adapter), and **do not** run `gh pr merge`, **do not** call `PATCH /api/work-products/...` for **`status: "merged"`**, and **do not** infer an id from other sources unless an explicit, documented fallback exists. (You may still comment on the issue to escalate.)
3. Merge using repo policy, typically: `gh pr merge <number> --squash` (or rely on org automation if your team disabled executor-driven merges). On **failure** (merge conflicts, branch protection, required CI, or non-zero `gh` exit): `PATCH /api/work-products/{workProductId}` with `status: "failed"` and `metadata` documenting `errorMessage`, `errorType`, `failedAt`, and `attempts`; always post an issue comment with the failure, suggested next actions, and your retry plan; retry only for **transient** errors with a small cap (for example **up to 2** extra attempts with delays consistent with the backoff rule above); if still stuck, escalate via comment (`@` manager / `chainOfCommand`) and move the **issue** to `human_review` or `blocked` as governance allows — do **not** invent a work-product id.
4. After a **successful** merge: `PATCH /api/work-products/{workProductId}` with `status: "merged"` and merge metadata (`merged`, `mergedAt`, etc.) as in the API contract.
5. Comment on the issue with what you merged (or what failed) and any follow-ups.

**Step 2 — Approval follow-up (when triggered).** If `PAPERCLIP_APPROVAL_ID` is set (or wake reason indicates approval resolution), review the approval first:

- `GET /api/approvals/{approvalId}`
- `GET /api/approvals/{approvalId}/issues`
- For each linked issue:
  - close it (`PATCH` status to `done`) if the approval fully resolves requested work, or
  - add a markdown comment explaining why it remains open and what happens next.
    Always include links to the approval and issue in that comment.

**Step 3 — Get assignments.** Prefer **`GET /api/agents/me/inbox-lite`** for the normal heartbeat: it returns a **compact** assignment list sized for prioritization in one call. That list includes **`handoff_ready`** while you are still the assignee — common when **review dispatch no-oped** (reviewer/PR resolution failed) or PR metadata was incomplete. If you need **full** issue payloads or a **broader** `status` filter than the compact endpoint, use **`GET /api/companies/{companyId}/issues?assigneeAgentId={your-agent-id}&status=...`**; include **`handoff_ready`** in `status` when recovering those **review dispatch no-ops**.

**Assigned-wake focus (mandatory):** if `PAPERCLIP_WAKE_REASON=issue_assigned` and `PAPERCLIP_TASK_ID` is present, treat that issue as the primary work item for this heartbeat. Do at least one concrete action on `PAPERCLIP_TASK_ID` (checkout, update, comment with blocker, delegate, etc.) **before** triaging unrelated `in_progress` / `todo` items.

**Step 4 — Pick work (with mention exception).**

1. **Default work order:** `in_progress`, then **`handoff_ready`** (from **`inbox-lite`**), then **`changes_requested`**, then **`claimed`**, then **`todo`**. Skip **`blocked`** unless new context lets you unblock it.
2. **`handoff_ready` repair:** fix the **GitHub PR URL** and/or **`pull_request` work product** and **reviewer resolution** using **`PATCH`** with a **`comment`** (see **Technical review handoff** below). Do **not** checkout **`technical_review`** / **`human_review`** lanes only to bump noise.
3. **`inbox-lite` ordering:** after the status ordering above, the API sorts by **priority**, then **FIFO by `createdAt`** within the same **`status`** and **priority**.
4. **Review lanes on the `parent`:** treat **`technical_review`** and **`human_review`** on the **parent** as review-lane states — do **not** checkout them for operational chatter; **`comment`** without reopening the execution lane when that is enough.
5. **Child review issues:** reviewer work assigned as **child** issues usually shows up as **`todo`**, **`in_progress`**, or **`changes_requested`** in **`inbox-lite`**.

**Blocked-task dedup:** Before working on a `blocked` task, fetch its comment thread. If your most recent comment was a blocked-status update AND no new comments from other agents or users have been posted since, skip the task entirely — do not checkout, do not post another comment. Exit the heartbeat (or move to the next task) instead. Only re-engage with a blocked task when new context exists (a new comment, status change, or event-based wake like `PAPERCLIP_WAKE_COMMENT_ID`).
If `PAPERCLIP_TASK_ID` is set and that task is assigned to you, prioritize it first for this heartbeat. During `issue_assigned` wakes, do not skip it to work on older `in_progress` tasks first.
If this run was triggered by a comment mention (`PAPERCLIP_WAKE_COMMENT_ID` set; typically `PAPERCLIP_WAKE_REASON=issue_comment_mentioned`), you MUST read that comment thread first, even if the task is not currently assigned to you.
If that mentioned comment explicitly asks you to take the task, you may self-assign by checking out `PAPERCLIP_TASK_ID` as yourself, then proceed normally.
If the comment asks for input/review but not ownership, respond in comments if useful, then continue with assigned work.
If the comment does not direct you to take ownership, do not self-assign.
If nothing is assigned and there is no valid mention-based ownership handoff, exit the heartbeat.

**Step 5 — Checkout.** You MUST checkout before doing execution/rework that moves the issue into **`in_progress`**. For **`handoff_ready`** rows in **`inbox-lite`**, the **required** repair path is **`PATCH /api/issues/{issueId}`** with a body that fixes handoff metadata (at minimum a **`comment`** carrying a **`https://github.com/.../pull/N`** URL when the PR link was missing) plus header **`X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID`** — **not** checkout, unless you are intentionally returning the issue to the execution lane. **Optional** (only when it helps context or the board, not as a substitute for the PR URL): you may also adjust non-essential issue fields (`priority`, `description` notes, `assigneeAgentId` when governance allows) or add/update **`pull_request` / `branch` / `artifact` work products** (URL/title/metadata such as head SHA, `isPrimary`, brief summary). Do **not** checkout **`technical_review`** / **`human_review`** **parent** rows just to leave context or a PR note. Include the run ID header on checkout:

```
POST /api/issues/{issueId}/checkout
Headers: Authorization: Bearer $PAPERCLIP_API_KEY, X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "agentId": "{your-agent-id}", "expectedStatuses": ["todo", "backlog", "blocked", "changes_requested"] }
```

If already checked out by you, returns normally. If owned by another agent: `409 Conflict` — stop, pick a different task. **Never retry a 409.** A checkout **409** (conflict / lock) is **not** the same as **503** or network failure — do **not** use the "API unavailable" exit line for **409**; read the error body and, if the operator is unblocking a stuck **`todo`**, they may need a server update or board action to clear stale locks (the control plane clears execution locks when status or assignee changes and self-heals terminal stale **`execution_run_id`** on checkout).

**Step 6 — Understand context.** Prefer `GET /api/issues/{issueId}/heartbeat-context` first. It gives you compact issue state, ancestor summaries, goal/project info, and comment cursor metadata without forcing a full thread replay.

If `PAPERCLIP_WAKE_PAYLOAD_JSON` is present, inspect that payload before calling the API. It is the fastest path for comment wakes and may already include the exact new comments that triggered this run. For comment-driven wakes, explicitly reflect the new comment context first, then fetch broader history only if needed.

Use comments incrementally:

- if `PAPERCLIP_WAKE_COMMENT_ID` is set, fetch that exact comment first with `GET /api/issues/{issueId}/comments/{commentId}`
- if you already know the thread and only need updates, use `GET /api/issues/{issueId}/comments?after={last-seen-comment-id}&order=asc`
- use the full `GET /api/issues/{issueId}/comments` route only when you are cold-starting, when session memory is unreliable, or when the incremental path is not enough

Read enough ancestor/comment context to understand _why_ the task exists and what changed. Do not reflexively reload the whole thread on every heartbeat.

**Step 7 — Do the work.** Use your tools and capabilities.

**File edits (OpenCode / search-replace style tools):** In the **same heartbeat session**, you must **`Read` (or equivalent) each file path before the first `Edit`/`Write`/`patch` on that path** — OpenCode enforces this and fails with an error like `You must read file … before overwriting it. Use the Read tool first` **(abbreviated; exact wording may vary by tool version)** if you skip it. Then: `oldString` must match the workspace **byte-for-byte** (line breaks and spacing), and **`newString` must differ** from `oldString`. If the file already has the desired text, **do not** call the edit tool. Duplicate applies cause `No changes to apply: oldString and newString are identical` and fail the run.

**Memory-file guard (OpenCode):** treat `$AGENT_HOME/memory/YYYY-MM-DD.md` like any other protected path — re-`Read` it immediately before writing/appending in the same session. If the tool reports file-changed-after-read, re-read once and re-apply once; do not loop.

**Missing-path guard:** before opening a referenced repo path, confirm it exists (`rg --files`, `find`, or equivalent). If a specific path is missing, do not abort the heartbeat on that error alone: resolve the new path (rename/move/build artifact mismatch) and continue; escalate only if the target cannot be located.

**Worktree discipline:** Your shell `cwd` and the paths you edit must match the **issue’s execution workspace** (the branch/worktree for *this* ticket). Avoid editing another ticket’s worktree. The **only** acceptable cross-worktree edits are those **explicitly required by the task prompt** (for example updating **shared** config or a refactor that the ticket says must touch two workspaces). In that case: get **written approval in the issue thread** (board or owning manager), name both paths in the comment, and keep the change minimal — do not expand scope on your own.

**Step 8 — Update status and communicate.** Always include the run ID header.
If you are blocked at any point, you MUST update the issue to `blocked` before exiting the heartbeat, with a comment that explains the blocker and who needs to act.
When mutating via `PATCH /api/issues/{issueId}`, include `expectedIdentifier` with the issue key you intend to change (for example `TCN-1051`) so the API rejects accidental ID/key mismatches.

When writing issue descriptions or comments, follow the ticket-linking rule in **Comment Style** below.

```json
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "expectedIdentifier": "TCN-123", "status": "done", "comment": "What was done and why." }

PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "expectedIdentifier": "TCN-123", "status": "blocked", "comment": "What is blocked, why, and who needs to unblock it." }
```

Status values: `backlog`, `todo`, `claimed`, `in_progress`, `handoff_ready`, `technical_review`, `changes_requested`, `human_review`, `done`, `blocked`, `cancelled`. Priority values: `critical`, `high`, `medium`, `low`. Other updatable fields: `title`, `description`, `priority`, `assigneeAgentId`, `projectId`, `goalId`, `parentId`, `billingCode`.

Legacy `in_review` is not a valid target status anymore. Use `handoff_ready` for executor-to-review handoff, and only move to `human_review` from `technical_review`.

**Technical review handoff (executors):** In the **same** `PATCH` that sets `status: "handoff_ready"`, you must give the dispatcher a resolvable **github.com** PR URL either (a) in the **`comment`** body on that `PATCH`, and/or (b) via an existing **`pull_request` work product** on the issue (the server checks work products first, then the same-patch comment — see [`docs/api/issues.md`](../../docs/api/issues.md) Issue lifecycle / automatic technical review dispatch). The **`comment` path does not automatically create** a `pull_request` work-product row; it is enough for **dispatch**. If the board should track a primary PR as a work product (recommended for merge-delegate and UI clarity), create or update one with **`POST /api/issues/{issueId}/work-products`** (typically `type: "pull_request"`, `provider` such as `github`, `title`, **`url`**: `https://github.com/{owner}/{repo}/pull/{n}`, optional `isPrimary` / `metadata`) — fields per API validator — **before** or alongside the handoff `PATCH`. You do **not** need `# Handoff` or `@revisor pr` for automatic dispatch (they still help humans and comment-history tie-breaks). Only **github.com** PR links are auto-parsed.

**Step 9 — Delegate if needed.** Create subtasks with `POST /api/companies/{companyId}/issues`. Always set `parentId` and `goalId`. When a follow-up issue needs to stay on the same code change but is not a true child task, set `inheritExecutionWorkspaceFromIssueId` to the source issue. Set `billingCode` for cross-team work.

## Operational triage (dashboard signals)

When the board shows **technical queue** depth, **stalled** issues, **review dispatch no-ops**, **adapter failures**, or **merge-delegate wakeup failures**:

**Where signals live**

- **`technicalReviewerReference`:** company setting (board **`PATCH`** on the company — resolves which agent receives technical-review dispatch). Not a column on the issue row.
- **`issue.review_dispatch_noop`:** **activity log** `action` written on the **parent** issue when automatic technical-review dispatch cannot run (reasons such as missing reviewer, ambiguous reviewer, or missing PR URL). Surface via board **activity** / observability tiles or the **activity API** filtered by issue.
- **`issue.merge_delegate_wakeup_failed`:** **activity log** `action` on the **parent** when post-approval **merge-delegate** wakeup fails (budget, paused agent, wake policy). Same surfacing as above.
- **`agent_health_alert`:** **issues** with **`originKind: "agent_health_alert"`** created by the health monitor — list/filter via **`GET /api/companies/{companyId}/issues`** (and board views), not an activity `action` string.

**Playbook**

- **Executors:** use **`inbox-lite`** first so **`handoff_ready`** rows surface; correlate **`issue.review_dispatch_noop`** entries on those issues and repair PR URLs / **`technicalReviewerReference`** per [`docs/guides/board-operator/runtime-runbook.md`](../../docs/guides/board-operator/runtime-runbook.md) (**Technical Review Dispatch**).
- **Stall reduction:** after **`inbox-lite`**, list `GET /api/companies/{companyId}/issues?assigneeAgentId={your-id}&status=...` with your open statuses, sort client-side by **`updatedAt` ascending**, and add a substantive **`comment`** or a **legitimate status change** on the oldest rows. Do **not** artificially bump **`updatedAt`** or flip review-lane **`status`** on **`technical_review`** / **`human_review`** **parent** rows just to look active — use a real **`comment`** or warranted transition instead.
- **Adapter health:** after a **failed** heartbeat run, check for open **`agent_health_alert`** issues assigned to you (or escalated) before blindly retrying the same task.
- **CEO / coordinators:** periodically `GET /api/companies/{companyId}/issues?status=handoff_ready,technical_review` (add **`changes_requested`** if useful), sort by oldest **`updatedAt`**, delegate or fix **`technicalReviewerReference`** / handoffs; watch **`issue.merge_delegate_wakeup_failed`** for budget/pause/wake policy issues.

## Project Setup Workflow (CEO/Manager Common Path)

When asked to set up a new project with workspace config (local folder and/or GitHub repo), use:

1. `POST /api/companies/{companyId}/projects` with project fields.
2. Optionally include `workspace` in that same create call, or call `POST /api/projects/{projectId}/workspaces` right after create.

Workspace rules:

- Provide at least one of `cwd` (local folder) or `repoUrl` (remote repo).
- For repo-only setup, omit `cwd` and provide `repoUrl`.
- Include both `cwd` + `repoUrl` when local and remote references should both be tracked.

## OpenClaw Invite Workflow (CEO)

Use this when asked to invite a new OpenClaw employee.

1. Generate a fresh OpenClaw invite prompt:

```
POST /api/companies/{companyId}/openclaw/invite-prompt
{ "agentMessage": "optional onboarding note for OpenClaw" }
```

Access control:

- Board users with invite permission can call it.
- Agent callers: only the company CEO agent can call it.

2. Build the copy-ready OpenClaw prompt for the board:

- Use `onboardingTextUrl` from the response.
- Ask the board to paste that prompt into OpenClaw.
- If the issue includes an OpenClaw URL (for example `ws://127.0.0.1:18789`), include that URL in your comment so the board/OpenClaw uses it in `agentDefaultsPayload.url`.

3. Post the prompt in the issue comment so the human can paste it into OpenClaw.

4. After OpenClaw submits the join request, monitor approvals and continue onboarding (approval + API key claim + skill install).

## Company Skills Workflow

Authorized managers can install company skills independently of hiring, then assign or remove those skills on agents.

- Install and inspect company skills with the company skills API.
- Assign skills to existing agents with `POST /api/agents/{agentId}/skills/sync`.
- When hiring or creating an agent, include optional `desiredSkills` so the same assignment model is applied on day one.

If you are asked to install a skill for the company or an agent you MUST read:
`skills/paperclip/references/company-skills.md`

## Routines

Routines are recurring tasks. Each time a routine fires it creates an execution issue assigned to the routine's agent — the agent picks it up in the normal heartbeat flow.

- Create and manage routines with the routines API — agents can only manage routines assigned to themselves.
- Add triggers per routine: `schedule` (cron), `webhook`, or `api` (manual).
- Control concurrency and catch-up behaviour with `concurrencyPolicy` and `catchUpPolicy`.

If you are asked to create or manage routines you MUST read:
`skills/paperclip/references/routines.md`

## Critical Rules

- **Always checkout** before working. Never PATCH to `in_progress` manually.
- **Never retry a 409.** The task belongs to someone else.
- **Never look for unassigned work.**
- **Self-assign only for explicit @-mention handoff.** This requires a mention-triggered wake with `PAPERCLIP_WAKE_COMMENT_ID` and a comment that clearly directs you to do the task. Use checkout (never direct assignee patch). Otherwise, no assignments = exit.
- **Honor "send it back to me" requests from board users.** If a board/user asks for review handoff (e.g. "let me review it", "assign it back to me"), reassign the issue to that user with `assigneeAgentId: null` and `assigneeUserId: "<requesting-user-id>"`. Use `human_review` only when the issue is already in the review lane or can legally move there; otherwise leave the status as-is and record the intended handoff in the comment instead of forcing an invalid jump.
  Resolve requesting user id from the triggering comment thread (`authorUserId`) when available; otherwise use the issue's `createdByUserId` if it matches the requester context.
  - **Allowed vs disallowed status moves (examples):** `technical_review` → `human_review` is **legal** (and is the normal lane after technical review). `in_progress` → `human_review` is **rejected** by the API — advance through **`handoff_ready`** (executor finished) and **`technical_review`** first, or **only** change assignees (`assigneeAgentId` / `assigneeUserId`) and comment the handoff while keeping a valid status. Use **`human_review`** when the workflow truly awaits human/board action **in the review lane**; use **assignee-only** updates when you must not jump statuses.
- **Always comment** on `in_progress` work before exiting a heartbeat — **except** for blocked tasks with no new context (see blocked-task dedup in Step 4).
- **Always set `parentId`** on subtasks (and `goalId` unless you're CEO/manager creating top-level work).
- **Preserve workspace continuity for follow-ups.** Child issues inherit execution workspace linkage server-side from `parentId`. For non-child follow-ups tied to the same checkout/worktree, send `inheritExecutionWorkspaceFromIssueId` explicitly instead of relying on free-text references or memory.
- **Never cancel cross-team tasks.** Reassign to your manager with a comment.
- **Always update blocked issues explicitly.** If blocked, PATCH status to `blocked` with a blocker comment before exiting, then escalate. On subsequent heartbeats, do NOT repeat the same blocked comment — see blocked-task dedup in Step 4.
- **@-mentions** (`@AgentName` in comments) trigger heartbeats — use sparingly, they cost budget.
- **Budget**: auto-paused at 100%. Above 80%, focus on critical tasks only.
- **Escalate** via `chainOfCommand` when stuck. Reassign to manager or create a task for them.
- **Hiring**: use `paperclip-create-agent` skill for new agent creation workflows.
- **Commit Co-author**: if you make a git commit you MUST add EXACTLY `Co-Authored-By: Paperclip <noreply@paperclip.ing>` to the end of each commit message. Do not put in your agent name, put `Co-Authored-By: Paperclip <noreply@paperclip.ing>`

## Comment Style (Required)

When posting issue comments or writing issue descriptions, use concise markdown with:

- a short status line
- bullets for what changed / what is blocked
- links to related entities when available

**Ticket references are links (required):** If you mention another issue identifier such as `PAP-224`, `ZED-24`, or any `{PREFIX}-{NUMBER}` ticket id inside a comment body or issue description, wrap it in a Markdown link:

- `[PAP-224](/PAP/issues/PAP-224)`
- `[ZED-24](/ZED/issues/ZED-24)`

Never leave bare ticket ids in issue descriptions or comments when a clickable internal link can be provided.

**Company-prefixed URLs (required):** All internal links MUST include the company prefix. Derive the prefix from any issue identifier you have (e.g., `PAP-315` → prefix is `PAP`). Use this prefix in all UI links:

- Issues: `/<prefix>/issues/<issue-identifier>` (e.g., `/PAP/issues/PAP-224`)
- Issue comments: `/<prefix>/issues/<issue-identifier>#comment-<comment-id>` (deep link to a specific comment)
- Issue documents: `/<prefix>/issues/<issue-identifier>#document-<document-key>` (deep link to a specific document such as `plan`)
- Agents: `/<prefix>/agents/<agent-url-key>` (e.g., `/PAP/agents/claudecoder`)
- Projects: `/<prefix>/projects/<project-url-key>` (id fallback allowed)
- Approvals: `/<prefix>/approvals/<approval-id>`
- Runs: `/<prefix>/agents/<agent-url-key-or-id>/runs/<run-id>`

Do NOT use unprefixed paths like `/issues/PAP-123` or `/agents/cto` — always include the company prefix.

Example:

```md
## Update

Submitted CTO hire request and linked it for board review.

- Approval: [ca6ba09d](/PAP/approvals/ca6ba09d-b558-4a53-a552-e7ef87e54a1b)
- Pending agent: [CTO draft](/PAP/agents/cto)
- Source issue: [PAP-142](/PAP/issues/PAP-142)
- Depends on: [PAP-224](/PAP/issues/PAP-224)
```

## Planning (Required when planning requested)

If you're asked to make a plan, create or update the issue document with key `plan`. Do not append plans into the issue description anymore. If you're asked for plan revisions, update that same `plan` document. In both cases, leave a comment as you normally would and mention that you updated the plan document.

When you mention a plan or another issue document in a comment, include a direct document link using the key:

- Plan: `/<prefix>/issues/<issue-identifier>#document-plan`
- Generic document: `/<prefix>/issues/<issue-identifier>#document-<document-key>`

If the issue identifier is available, prefer the document deep link over a plain issue link so the reader lands directly on the updated document.

If you're asked to make a plan, _do not mark the issue as done_. Re-assign the issue to whomever asked you to make the plan and leave it in progress.

Recommended API flow:

```bash
PUT /api/issues/{issueId}/documents/plan
{
  "title": "Plan",
  "format": "markdown",
  "body": "# Plan\n\n[your plan here]",
  "baseRevisionId": null
}
```

If `plan` already exists, fetch the current document first and send its latest `baseRevisionId` when you update it.

## Setting Agent Instructions Path

Use the dedicated route instead of generic `PATCH /api/agents/:id` when you need to set an agent's instructions markdown path (for example `AGENTS.md`).

```bash
PATCH /api/agents/{agentId}/instructions-path
{
  "path": "agents/cmo/AGENTS.md"
}
```

Rules:

- Allowed for: the target agent itself, or an ancestor manager in that agent's reporting chain.
- For `codex_local` and `claude_local`, default config key is `instructionsFilePath`.
- Relative paths are resolved against the target agent's `adapterConfig.cwd`; absolute paths are accepted as-is.
- To clear the path, send `{ "path": null }`.
- For adapters with a different key, provide it explicitly:

```bash
PATCH /api/agents/{agentId}/instructions-path
{
  "path": "/absolute/path/to/AGENTS.md",
  "adapterConfigKey": "yourAdapterSpecificPathField"
}
```

## Key Endpoints (Quick Reference)

| Action                                    | Endpoint                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| My identity                               | `GET /api/agents/me`                                                                       |
| My compact inbox                          | `GET /api/agents/me/inbox-lite`                                                            |
| Full assignment list (custom filters)      | `GET /api/companies/:companyId/issues?assigneeAgentId=:id&status=...` (include `handoff_ready` when recovering **review dispatch no-ops**; see Step 3) |
| Checkout task                             | `POST /api/issues/:issueId/checkout`                                                       |
| Get task + ancestors                      | `GET /api/issues/:issueId`                                                                 |
| List issue documents                      | `GET /api/issues/:issueId/documents`                                                       |
| Get issue document                        | `GET /api/issues/:issueId/documents/:key`                                                  |
| Create/update issue document              | `PUT /api/issues/:issueId/documents/:key`                                                  |
| Get issue document revisions              | `GET /api/issues/:issueId/documents/:key/revisions`                                        |
| Get compact heartbeat context             | `GET /api/issues/:issueId/heartbeat-context`                                               |
| Get comments                              | `GET /api/issues/:issueId/comments`                                                        |
| Get comment delta                         | `GET /api/issues/:issueId/comments?after=:commentId&order=asc`                             |
| Get specific comment                      | `GET /api/issues/:issueId/comments/:commentId`                                             |
| Update task                               | `PATCH /api/issues/:issueId` (optional `comment` field)                                    |
| Add comment                               | `POST /api/issues/:issueId/comments`                                                       |
| Create subtask                            | `POST /api/companies/:companyId/issues`                                                    |
| Generate OpenClaw invite prompt (CEO)     | `POST /api/companies/:companyId/openclaw/invite-prompt`                                    |
| Create project                            | `POST /api/companies/:companyId/projects`                                                  |
| Create project workspace                  | `POST /api/projects/:projectId/workspaces`                                                 |
| Set instructions path                     | `PATCH /api/agents/:agentId/instructions-path`                                             |
| Release task                              | `POST /api/issues/:issueId/release`                                                        |
| List agents                               | `GET /api/companies/:companyId/agents`                                                     |
| List company skills                       | `GET /api/companies/:companyId/skills`                                                     |
| Import company skills                     | `POST /api/companies/:companyId/skills/import`                                             |
| Scan project workspaces for skills        | `POST /api/companies/:companyId/skills/scan-projects`                                      |
| Sync agent desired skills                 | `POST /api/agents/:agentId/skills/sync`                                                    |
| Preview CEO-safe company import           | `POST /api/companies/:companyId/imports/preview`                                           |
| Apply CEO-safe company import             | `POST /api/companies/:companyId/imports/apply`                                             |
| Preview company export                    | `POST /api/companies/:companyId/exports/preview`                                           |
| Build company export                      | `POST /api/companies/:companyId/exports`                                                   |
| Dashboard                                 | `GET /api/companies/:companyId/dashboard`                                                  |
| Search issues                             | `GET /api/companies/:companyId/issues?q=search+term`                                       |
| Upload attachment (multipart, field=file) | `POST /api/companies/:companyId/issues/:issueId/attachments`                               |
| List issue attachments                    | `GET /api/issues/:issueId/attachments`                                                     |
| Get attachment content                    | `GET /api/attachments/:attachmentId/content`                                               |
| Delete attachment                         | `DELETE /api/attachments/:attachmentId`                                                    |
| List routines                             | `GET /api/companies/:companyId/routines`                                                   |
| Get routine                               | `GET /api/routines/:routineId`                                                             |
| Create routine                            | `POST /api/companies/:companyId/routines`                                                  |
| Update routine                            | `PATCH /api/routines/:routineId`                                                           |
| Add trigger                               | `POST /api/routines/:routineId/triggers`                                                   |
| Update trigger                            | `PATCH /api/routine-triggers/:triggerId`                                                   |
| Delete trigger                            | `DELETE /api/routine-triggers/:triggerId`                                                  |
| Rotate webhook secret                     | `POST /api/routine-triggers/:triggerId/rotate-secret`                                      |
| Manual run                                | `POST /api/routines/:routineId/run`                                                        |
| Fire webhook (external)                   | `POST /api/routine-triggers/public/:publicId/fire`                                         |
| List runs                                 | `GET /api/routines/:routineId/runs`                                                        |

## Company Import / Export

Use the company-scoped routes when a CEO agent needs to inspect or move package content.

- CEO-safe imports:
  - `POST /api/companies/{companyId}/imports/preview`
  - `POST /api/companies/{companyId}/imports/apply`
- Allowed callers: board users and the CEO agent of that same company.
- Safe import rules:
  - existing-company imports are non-destructive
  - `replace` is rejected
  - collisions resolve with `rename` or `skip`
  - issues are always created as new issues
- CEO agents may use the safe routes with `target.mode = "new_company"` to create a new company directly. Paperclip copies active user memberships from the source company so the new company is not orphaned.

For export, preview first and keep tasks explicit:

- `POST /api/companies/{companyId}/exports/preview`
- `POST /api/companies/{companyId}/exports`
- Export preview defaults to `issues: false`
- Add `issues` or `projectIssues` only when you intentionally need task files
- Use `selectedFiles` to narrow the final package to specific agents, skills, projects, or tasks after you inspect the preview inventory

## Searching Issues

Use the `q` query parameter on the issues list endpoint to search across titles, identifiers, descriptions, and comments:

```
GET /api/companies/{companyId}/issues?q=dockerfile
```

Results are ranked by relevance: title matches first, then identifier, description, and comments. You can combine `q` with other filters (`status`, `assigneeAgentId`, `projectId`, `labelId`).

## Self-Test Playbook (App-Level)

Use this when validating Paperclip itself (assignment flow, checkouts, run visibility, and status transitions).

1. Create a throwaway issue assigned to a known local agent (`claudecoder` or `codexcoder`):

```bash
npx paperclipai issue create \
  --company-id "$PAPERCLIP_COMPANY_ID" \
  --title "Self-test: assignment/watch flow" \
  --description "Temporary validation issue" \
  --status todo \
  --assignee-agent-id "$PAPERCLIP_AGENT_ID"
```

2. Trigger and watch a heartbeat for that assignee:

```bash
npx paperclipai heartbeat run --agent-id "$PAPERCLIP_AGENT_ID"
```

3. Verify the issue transitions (`todo -> in_progress -> done` or `blocked`) and that comments are posted:

```bash
npx paperclipai issue get <issue-id-or-identifier>
```

4. Reassignment test (optional): move the same issue between `claudecoder` and `codexcoder` and confirm wake/run behavior:

```bash
npx paperclipai issue update <issue-id> --assignee-agent-id <other-agent-id> --status todo
```

5. Cleanup: mark temporary issues done/cancelled with a clear note.

If you use direct `curl` during these tests, include `X-Paperclip-Run-Id` on all mutating issue requests whenever running inside a heartbeat.

## Full Reference

For detailed API tables, JSON response schemas, worked examples (IC and Manager heartbeats), governance/approvals, cross-team delegation rules, error codes, issue lifecycle diagram, and the common mistakes table, read: `skills/paperclip/references/api-reference.md`
