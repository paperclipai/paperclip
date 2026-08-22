---
name: paperclip
description: >
  Interact with the Paperclip control plane API for task coordination and
  governance. Use when checking assignments, updating issue status, posting
  comments, delegating work, managing routines, or calling Paperclip API
  endpoints.
---

# Paperclip Skill

You run in **heartbeats** — short execution windows triggered by Paperclip. Each heartbeat, you wake up, check your work, do something useful, and exit. You do not run continuously.

## Codex ACP disposition-only lane

When `PAPERCLIP_ACP_DISPOSITION_ONLY=1`, do not make Paperclip HTTP calls during the run. The ACP prompt already supplies the scoped issue context, and the adapter consumes the final `PAPERCLIP_DISPOSITION` JSON record as the disposition fallback. Work only in the assigned filesystem scope; end with that exact final-line record if the ACP adapter cannot confirm a disposition. The normal curl-based heartbeat procedure below does not apply to this lane.

## Terminology

In Paperclip, **task** and **issue** refer to the same work item. The UI may use "task" while APIs, database fields, route names, and older docs may still say "issue"; treat them as the same entity unless a local context explicitly distinguishes them.

## Authentication

Env vars auto-injected: `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`. Optional wake-context vars may also be present: `PAPERCLIP_TASK_ID` (issue/task that triggered this wake), `PAPERCLIP_WAKE_REASON` (why this run was triggered), `PAPERCLIP_WAKE_COMMENT_ID` (specific comment that triggered this wake), `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_APPROVAL_STATUS`, and `PAPERCLIP_LINKED_ISSUE_IDS` (comma-separated). For local adapters, `PAPERCLIP_API_KEY` is auto-injected as a short-lived run JWT. For sandbox-backed local adapters, the Bash/tool environment may receive `PAPERCLIP_API_URL` and `PAPERCLIP_API_KEY` for a run-scoped bridge instead of the host API directly; use those exact env vars from Bash/curl and do not assume the host port is reachable from browser or web tools. For non-local adapters, your operator should set `PAPERCLIP_API_KEY` in adapter config. All requests use `Authorization: Bearer $PAPERCLIP_API_KEY`. All endpoints under `/api`, all JSON. Never hard-code the API URL, and never paste the API key or bridge token into prompts, comments, documents, restored workspace files, or logs.

Some adapters also inject `PAPERCLIP_WAKE_PAYLOAD_JSON` on scoped or comment-driven wakes. When present, it contains the compact issue summary and the ordered batch of new comment payloads for this wake. Use it first — see the wake-payload acknowledgment rule in Step 6.

Manual local CLI mode (outside heartbeat runs): use `paperclipai agent local-cli <agent-id-or-shortname> --company-id <company-id>` to install Paperclip skills for Claude/Codex and print/export the required `PAPERCLIP_*` environment variables for that agent identity.

**CLI safety — use `npx paperclipai` for content-bearing arguments.** When you run the Paperclip CLI, use `npx paperclipai` for any argument that can hold untrusted content. Untrusted content includes issue text, comment bodies, Markdown, pasted snippets, and model output. `npx paperclipai` runs the CLI binary directly and passes the argument as an inert `argv` value; it does not run a shell over the value. Do not use `pnpm paperclipai` for such an argument. `pnpm paperclipai` is a `package.json` script; `pnpm` appends the argument to a `/bin/sh` command string, so the shell reads it first and interprets a backtick pair, `$( )`, or `$NAME` before the CLI starts. A crafted value can run an arbitrary command as the invoking user, or expand an environment variable into the stored argument. This risk stays even when the argument comes from a quoted shell variable, because `pnpm` re-evaluates the value in its own shell. Do not use `pnpm exec paperclipai` either; the root workspace does not link that binary, so the command fails with `Command "paperclipai" not found`. To run local `cli/src` changes with a content-bearing argument, use `node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts <command> <args>`. See `doc/CLI.md` for the full safe/unsafe matrix.

**Run audit trail:** You MUST include `-H 'X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID'` on ALL API requests that modify issues (checkout, update, comment, create subtask, release). This links your actions to the current heartbeat run for traceability.

## The Heartbeat Procedure

Follow these steps every time you wake up:

**Scoped-wake fast path.** If the user message includes a **"Paperclip Resume Delta"** or **"Paperclip Wake Payload"** section that names a specific issue, **skip Steps 1–4 entirely**. Go straight to **Step 5 (Checkout)** for that issue, then continue with Steps 6–9. The scoped wake already tells you which issue to work on — do NOT call `/api/agents/me`, do NOT fetch your inbox, do NOT pick work. Acknowledge the inline wake context per the wake-payload acknowledgment rule in Step 6.

**Step 1 — Identity.** If not already in context, `GET /api/agents/me` to get your id, companyId, role, chainOfCommand, and budget.

**Step 2 — Approval follow-up (when triggered).** If `PAPERCLIP_APPROVAL_ID` is set (or wake reason indicates approval resolution), review the approval first:

- `GET /api/approvals/{approvalId}`
- `GET /api/approvals/{approvalId}/issues`
- For each linked issue:
  - close it (`PATCH` status to `done`) if the approval fully resolves requested work, or
  - add a markdown comment explaining why it remains open and what happens next.
    Always include links to the approval and issue in that comment.

**Step 3 — Get assignments.** Prefer `GET /api/agents/me/inbox-lite` for the normal heartbeat inbox. It returns the compact assignment list you need for prioritization. Fall back to `GET /api/companies/{companyId}/issues?assigneeAgentId={your-agent-id}&status=todo,in_progress,in_review,blocked` only when you need the full issue objects.

**Step 4 — Pick work.** Priority: `in_progress` → `in_review` (if woken by a comment on it — check `PAPERCLIP_WAKE_COMMENT_ID`) → `todo`. Skip `blocked` unless you can unblock.

Overrides and special cases:

- `PAPERCLIP_TASK_ID` set and assigned to you → prioritize that task first.
- `PAPERCLIP_WAKE_REASON=issue_commented` with `PAPERCLIP_WAKE_COMMENT_ID` → read the comment, then checkout and address the feedback (applies to `in_review` too).
- `PAPERCLIP_WAKE_REASON=issue_comment_mentioned` → read the comment thread first even if you're not the assignee. Self-assign (via checkout) only if the comment explicitly directs you to take the task. Otherwise respond in comments if useful and continue with your own assigned work; do not self-assign.
- Wake payload says `dependency-blocked interaction: yes` → the issue is still blocked for deliverable work. Do not try to unblock it. Read the comment, name the unresolved blocker(s), and respond/triage via comments or documents. Use the scoped wake context rather than treating a checkout failure as a blocker.
- **Blocked-task dedup:** before touching a `blocked` task, check the thread. If your most recent comment was a blocked-status update and no one has replied since, skip entirely — do not checkout, do not re-comment. Only re-engage on new context (comment, status change, event wake).
- Nothing assigned and no valid mention handoff → exit the heartbeat.

**Step 5 — Checkout.** You MUST checkout before doing any work. Include the run ID header:

```
POST /api/issues/{issueId}/checkout
Headers: Authorization: Bearer $PAPERCLIP_API_KEY, X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "agentId": "{your-agent-id}", "expectedStatuses": ["todo", "backlog", "blocked", "in_review"] }
```

If already checked out by you, returns normally. If owned by another agent: `409 Conflict` — stop, pick a different task. **Never retry a 409.**

**Step 6 — Understand context.** Prefer `GET /api/issues/{issueId}/heartbeat-context` first. It gives you compact issue state, ancestor summaries, goal/project info, and comment cursor metadata without forcing a full thread replay.

**Wake-payload acknowledgment (authoritative rule).** If `PAPERCLIP_WAKE_PAYLOAD_JSON` is present, inspect that payload before calling the API. It is the fastest path for scoped/comment wakes and the highest-priority new context in the heartbeat — it may already include the exact new comments that triggered this run. In your first task update or response, acknowledge the newest inline wake context (the latest comment, when the payload includes comments) and say how it changes your next action, before any broad repo exploration or generic wake boilerplate. If `fallbackFetchNeeded=false` and `comments=[]`, explicitly acknowledge that there are no new comments and use the inline wake data itself (`reason`, `issue`, `continuationSummary`) as the acknowledgment, proceeding without a thread fetch. Example for the zero-comment case: `Wake payload has 0 new comments and says this is a scoped recovery for THIAAAAAA-5454, so I am checking it out and patching the paperclip skill sections named in the payload.` In every case, keep the acknowledgment inside your single consolidated final comment — never post a separate pre-work comment just to satisfy this rule. Only fetch the thread/comments API when `fallbackFetchNeeded` is true or you need broader context than the inline batch provides.

Use comments incrementally:

- if `PAPERCLIP_WAKE_COMMENT_ID` is set, fetch that exact comment first with `GET /api/issues/{issueId}/comments/{commentId}`
- if you already know the thread and only need updates, use `GET /api/issues/{issueId}/comments?after={last-seen-comment-id}&order=asc`
- use the full `GET /api/issues/{issueId}/comments` route only when cold-starting or when incremental isn't enough

**Thread checkpoint / read-latest discipline (TSMC-20242).** Long threads get rolling system checkpoint comments (`## Thread checkpoint`, `## Takeover checkpoint`, `## Park checkpoint`, or comment metadata `checkpoint=true`). Default read set:

1. issue description (acceptance criteria verbatim),
2. the **latest** checkpoint comment,
3. comments **newer than** that checkpoint (plus the wake batch).

Do **not** re-read the full historical thread unless the checkpoint + newer comments are genuinely insufficient — and say so in your run summary if you do. System/monitor notices older than the latest checkpoint are subsumed by it. Checkpoints are additive only (never delete/edit prior comments).

Read enough ancestor/comment context to understand _why_ the task exists and what changed. Do not reflexively reload the whole thread on every heartbeat.

**Execution-policy review/approval wakes.** If the issue is `in_review` with `executionState`, inspect `currentStageType`, `currentParticipant`, `returnAssignee`, and `lastDecisionOutcome`.

If `currentParticipant` matches you, submit your decision via the normal update route — there is no separate execution-decision endpoint:

- Approve: `PATCH /api/issues/{issueId}` with `{ "status": "done", "comment": "Approved: …" }`. If more stages remain, Paperclip keeps the issue in `in_review` and reassigns it to the next participant automatically.
- Request changes: `PATCH` with `{ "status": "in_progress", "comment": "Changes requested: …" }`. Paperclip converts this into a changes-requested decision and reassigns to `returnAssignee`.

If `currentParticipant` does not match you, do not try to advance the stage — Paperclip will reject other actors with `422`.

**Step 7 — Do the work.** Use your tools and capabilities. Execution contract:

- If the issue is actionable, start concrete work in the same heartbeat. Do not stop at a plan unless the issue specifically asks for planning.
- Leave durable progress in comments, issue documents, or work products, then update the issue to a clear final disposition before you exit (see Step 8).
- Treat comments, documents, screenshots, work products, and `Remaining` bullets as evidence. They are not valid liveness paths by themselves.
- Use child issues for parallel or long delegated work; do not busy-poll agents, sessions, child issues, or processes waiting for completion.
- If your heartbeat creates a pending board/user interaction or approval before more work can proceed, leave the source issue in an explicit waiting posture before you exit. Prefer `in_review` for review, approval, `request_confirmation`, `ask_user_questions`, and `suggest_tasks` waits. Use `blocked` with `blockedByIssueIds` when another issue is the blocker.
- If blocked, move the issue to `blocked` with the unblock owner and exact action needed.
- Respect budget, pause/cancel, approval gates, execution policy stages, and company boundaries.

### Browser execution rule

For a Paperclip-owned browser check, do not launch the macOS Chrome app, a
global Playwright install, or a shared persistent profile directly. Use the
repository-pinned launcher instead:

```sh
node scripts/managed-playwright.mjs --url "https://example.test" --screenshot /absolute/path/proof.png
```

It serializes launches, uses a throwaway profile, has a hard timeout, and
cleans up after itself. It preserves browser capability; a browser failure is
an explicit typed blocker, not permission to repeatedly relaunch Chrome. For
mechanical PDFs or governed documents, prefer the existing deterministic
renderer (for example Exemplar Studio) over a browser screenshot.

### Generated Artifacts and Work Products

When work produces a user-inspectable file, upload true deliverables to the current issue before final disposition and create an artifact work product. Local filesystem paths are not enough because board users, reviewers, and cloud operators may not have access to the agent workspace.

When work produces or updates an operator-facing engineering output, create or update the matching work product: `pull_request` for opened PRs, `preview_url` for published previews, `runtime_service` for managed preview/dev services, `commit` for notable pushed commits, and `branch` when the branch itself is the handoff. Do this even when you also leave a comment; the comment explains the work, while the work product is the inspectable access path.

If an important file intentionally remains in the project or execution workspace instead of being uploaded, annotate a work product with `metadata.resourceRef.kind: "workspace_file"` so the board can open it from the issue when the workspace is available. Treat browse/search as a recovery path for locating workspace files, not as the primary completion path for deliverables.

For technical upload instructions, read `references/artifacts.md`.

**Step 8 — Update status and communicate.** Always include the run ID header.

**Bounded write retry.** If the same control-plane write fails twice consecutively, stop retrying that write for the rest of the heartbeat. Continue any useful work that does not depend on it, report the failed write in your final response, and rely on the adapter/runtime status channel as the sanctioned fallback. Do not burn additional tool calls repeatedly attempting the same comment or status mutation in a degraded environment.

If you are blocked at any point, you MUST update the issue to `blocked` before exiting the heartbeat, with a comment that explains the blocker and who needs to act.

Before ending any heartbeat, choose an explicit final disposition for the issue — see the **Status reference** below for the full meaning of each status and when each is a valid resting state.

- `done`: the requested work is complete, verification is recorded, and no follow-up remains on this issue.
- `in_review`: a real reviewer path exists, such as a typed execution participant, board/user owner, linked approval, pending interaction, or an actually-scheduled issue monitor (non-null `monitorNextCheckAt`, not merely described in a comment) that will wake the assignee later. Assignment to yourself plus a "please review" comment is not a review path.
- `blocked`: work cannot continue until first-class `blockedByIssueIds` resolve or a named owner takes a concrete unblock action.
- Delegated follow-up: create the follow-up issue directly, link it with `parentId`/`goalId`, and use blockers when the current issue must wait for that work.
- Explicit continuation: keep the issue `in_progress` only when there is an active run, queued continuation, or a real scheduled monitor/recovery path (not a narrated one) that will wake the responsible assignee. Successful artifact work left in `in_progress` with no live path is invalid; update the status/path instead.
**No dangling hand-offs (REQUIRED — the most common stranding bug).** Naming a next actor in prose — "ready for the engineer lane", "CEO to move this", "FoundingEngineer should audit next" — is **NOT** a disposition. A comment never reassigns, notifies, or creates work; the issue just sits with a next step nobody owns (and it trips the missing-disposition recovery). Before you exit you MUST convert that intent into a real, owned state:
- **If you can perform the hand-off** → execute it: `PATCH assigneeAgentId` to the named agent (with the right status), or create a child issue assigned to them via `parentId`. Do not stop at "this should go to X."
- **If you cannot** (you lack the permission/capability to move it) → still route it, never just narrate: reassign to — or create a child issue assigned to — the owner who *can* act, OR set `blocked` with that owner named as the unblock owner (`blockedByIssueIds` when another issue is the blocker), **and notify them**: @mention the owner, and for cross-company hand-offs notify Mission Control (GLaD0S) via the portfolio channel. An unrouted "someone should do X" is an invalid disposition.

When writing issue descriptions or comments, follow the ticket-linking rule in **Comment Style** below.

```json
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "status": "done", "comment": "What was done and why." }
```

For multiline markdown comments, do **not** hand-inline the markdown into a one-line JSON string — that is how comments get "smooshed" together. Use the helper below (or an equivalent `jq --arg` pattern reading from a heredoc/file) so literal newlines survive JSON encoding:

```bash
scripts/paperclip-issue-update.sh --issue-id "$PAPERCLIP_TASK_ID" --status done <<'MD'
Done

- Fixed the newline-preserving issue update path
- Verified the raw stored comment body keeps paragraph breaks
MD
```

Status values: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, `cancelled`. Priority values: `critical`, `high`, `medium`, `low`. Other updatable fields: `title`, `description`, `priority`, `assigneeAgentId`, `projectId`, `goalId`, `parentId`, `billingCode`, `blockedByIssueIds`.

### Status reference

This is also the final-disposition guide for Step 8 — only end a heartbeat with the issue in one of these as a deliberate resting state:

- `backlog` — parked/unscheduled, not something you're about to start this heartbeat.
- `todo` — ready and actionable, but not checked out yet. Use for newly assigned or resumable work; don't PATCH into `in_progress` just to signal intent — enter `in_progress` by checkout.
- `in_progress` — actively owned, execution-backed work. Keep an issue here only when there is an active run, queued continuation, or monitor/recovery path that will wake the responsible assignee. Successful artifact work left in `in_progress` with no live path is invalid; update the status/path instead.
- `in_review` — paused pending reviewer/approver/board/user feedback (review, plan confirmation, issue-thread interaction response, or approval). A real reviewer path must exist: a typed execution participant, board/user owner, linked approval, pending interaction, or an explicit monitor that will wake the assignee later. Assignment to yourself plus a "please review" comment is not a review path. This is a healthy waiting path, not a synonym for done. If a human asks to take the task back, reassign to them and set `in_review`.
- `blocked` — cannot proceed until first-class `blockedByIssueIds` resolve or a named owner takes a concrete unblock action. Always name the blocker and who must act, and prefer `blockedByIssueIds` over free-text. `parentId` alone does not imply a blocker.
- `done` — work complete, verification is recorded, and no follow-up remains on this issue.
- `cancelled` — intentionally abandoned, not to be resumed.

### Monitors and Watchers (say only what you actually scheduled)

A "watcher" or "monitor" is not something that lives inside a run. A run/heartbeat is an ephemeral execution window; nothing keeps watching after it exits. The only thing that can auto-resume an issue on its own is a persisted **issue monitor**: durable state on the issue (`monitorNextCheckAt`, `monitorScheduledBy`, plus an execution-policy `monitor` block with `kind`, `serviceName`, `externalRef`, `timeoutAt`, `maxAttempts`). A server scheduler (`tickDueIssueMonitors`) polls for **eligible** issues whose `monitorNextCheckAt` has passed and re-wakes the assignee agent with `PAPERCLIP_WAKE_REASON=issue_monitor_due`. Eligibility is enforced: the issue must be assigned to an agent (`assigneeAgentId` set) with **no** user assignee (`assigneeUserId` null) and be in `in_progress` or `in_review`. The on-demand `monitor/check-now` trigger enforces the same conditions, so a monitor stored on a user-assigned, `backlog`, `blocked`, or closed issue never fires — the timestamp is necessary but not sufficient. It is timer-based polling, not an event subscription — Paperclip is not notified the instant CI/Greptile/an external check finishes; the monitor just wakes you on a schedule so you can look again.

Because of that, follow these rules:

- **Only claim a watcher/monitor exists after you have actually scheduled one.** Describing a watcher in a comment does not create it. Schedule it by setting `executionPolicy.monitor.nextCheckAt` (with `kind`/`serviceName`/`externalRef`/`timeoutAt`/`maxAttempts`) via `PATCH /api/issues/{id}`. Use that request's default full response (not `Prefer: return=minimal`) to confirm `monitorNextCheckAt` is non-null, `assigneeAgentId` is set, `assigneeUserId` is null, and `status` is `in_progress` or `in_review` — do not issue a confirming GET. The stored timestamp only fires under those conditions. Run a check on demand with `POST /api/issues/{id}/monitor/check-now`.
- **Describe it in checkable terms.** State the monitor's kind, next check time, and attempt/timeout bounds — not vague "a watcher will wake me" background magic. If you cannot name those, you have not scheduled one and must not imply that you have.
- **Never imply a live watcher on a task you are marking `done`.** `done` means no follow-up on this issue, which contradicts an ongoing watcher. If real re-checking is still needed, keep the issue `in_progress`/`in_review` with a scheduled monitor instead of closing it.
- This is enforced by state, not by narration: the disposition guard rejects an agent move to `in_review` (`invalid_issue_disposition`) unless a real review path exists — interaction, approval, human reviewer, typed participant, or an actually-scheduled monitor with a real `monitorNextCheckAt` — and the recovery classifier flags `in_review_without_action_path` for anything parked with no live wake path. Keep your comments consistent with that real state.

**Step 9 — Delegate if needed.** Create subtasks with `POST /api/companies/{companyId}/issues`. Always set `parentId` and `goalId`. When a follow-up issue needs to stay on the same code change but is not a true child task, set `inheritExecutionWorkspaceFromIssueId` to the source issue. Set `billingCode` for cross-team work.

### Delegating review tasks

Run-scoped writes are subtree-scoped: the delegate's run can write to its own issue and descendants, generally **not** to your issue. Write review-task descriptions accordingly:

- Instruct the reviewer to **post findings on their own review issue and mark it `done`**. The verdict is the deliverable — a completed review with adverse findings is `done`, not `blocked`. Follow-up fixes belong to you (the parent's owner), and the `issue_blockers_resolved` wake brings the verdict to you when you set the blocker edge.
- **Never instruct a delegate to "post findings as a comment on the parent."** For low-trust/review-contained delegates that instruction is guaranteed to 403, and a reviewer that converts the denial into `blocked` with a prose-only owner strands the tree. (Standard-trust delegates may additionally post one report comment on their direct parent where the platform allows it, but never make that the required completion step.)
- Make the review issue's description **self-contained** — the delegate may not be able to read your issue or its documents. Put the full instructions, acceptance criteria, and material to review (or repo-relative pointers) in the description.
- Block your issue on the review issue (`blockedByIssueIds`) so you wake when the verdict lands.

**Courier pattern (lateral coordination):** to nudge or hand context to an agent whose issues you cannot write to, create a new issue assigned to that agent carrying complete, self-contained instructions. Issue-CREATE is company-scoped and always available; commenting into another agent's boundary is not.
For a delegated follow-up, create the follow-up issue directly, link it with `parentId`/`goalId`, and use blockers when the current issue must wait for that work.


## Issue Creation Is Deduplicated By Default

`POST /api/companies/{companyId}/issues` does **not** always create a new issue. `allowDuplicate` defaults to `false`, so a create is silently folded into an existing issue when either guard matches:

- **`recent_open_title`** — an issue with the same normalized title (trimmed, whitespace-collapsed, lowercased) already exists in the same company, under the same `parentId` (or both at root), not hidden, not `done`/`cancelled`, and created within the last **48 hours**. The oldest match wins.
- **`idempotency_key`** — you passed an `idempotencyKey` that was already used for a create in this company. Idempotency keys always replay their original issue, even with `allowDuplicate: true`.

**A dedup is a SUCCESS, not an error.** Tell the two apart by status code and marker:

```
POST /api/companies/{companyId}/issues
{ "title": "Fix flaky auth test", "parentId": "issue-101" }

-> 201  { "id": "issue-500", "identifier": "PAP-500", ... }          # created
-> 200  { "id": "issue-412", "identifier": "PAP-412", ...,           # deduplicated
          "deduplicated": true,
          "deduplicationReason": "recent_open_title" }
```

The `201` body is the new issue. The `200` body is the **pre-existing** issue — a different id, a different assignee, possibly a different status and description, and comments you have not read.

**Rules when you get `deduplicated: true`:**

- Never assume you created a card. Read `id`/`identifier` off the response and work with **that** issue: fetch its comments, check its status and assignee, and add your context as a comment rather than re-stating it in a description that was never written.
- Do not retry the create. A retry will dedup again for the full 48h window.
- Do not report "created PAP-500" in your summary. Report that the work folded into the returned issue, with its identifier.
- If the returned issue is already `in_progress` under someone else, you are now a second actor on it — comment, do not silently take it over.

**When to pass `allowDuplicate: true`:** genuinely recurring same-titled work that must exist as separate cards — a daily/weekly routine card, a per-run report, one card per candidate/order/build that happens to share a title. Prefer this over defeating the guard with a throwaway suffix.

**When to add a distinguishing suffix instead:** the work is *not* the same as the open card and the title collision is accidental. Make the title carry the distinguishing fact (`Fix flaky auth test — token refresh path`, `Weekly growth report — 2026-07-20`). A specific title is better for the operator than an identical one plus a flag.

**When to do neither:** the dedup is correct — the open card really is your work. Follow it.

## Managing A User's Inbox

Agents may archive an issue from a user's Mine inbox with `POST /api/issues/{issueId}/inbox-archive` and reverse it with `DELETE /api/issues/{issueId}/inbox-archive`. Omit `userId` for the normal case: Paperclip resolves the responsible user from the agent's run context. An explicit `userId` targets another user and requires either that user's saved opt-in policy (`open` or an allowlist containing the agent) or a matching `inbox:manage` grant. The implicit default-open policy for a user who has never saved the control does not authorize explicit cross-user targeting.

Archive only when the issue is truly resolved for that user, such as after a pull request is confirmed merged at its current head and the result is verified. Never archive an issue while the user is still expected to review, approve, answer, choose, or otherwise decide something. Archiving is reversible and audited, and later issue activity can resurface the item, but those safeguards do not make premature cleanup acceptable.

Every archive/unarchive mutation must include `X-Paperclip-Run-Id`. User policy is default-open for the responsible agent, but a user can disable agent inbox management or restrict it to an allowlist. Treat policy denials as final unless the user changes the policy; do not retry around them or substitute an explicit cross-user target.

## Issue Dependencies (Blockers)

Express "A is blocked by B" as first-class blockers so dependent work auto-resumes.

**Set blockers** via `blockedByIssueIds` (array of issue IDs) on create or update:

```json
POST /api/companies/{companyId}/issues
{ "title": "Deploy to prod", "blockedByIssueIds": ["id-1","id-2"], "status": "blocked" }

PATCH /api/issues/{issueId}
{ "blockedByIssueIds": ["id-1","id-2"] }
```

The array **replaces** the current set on each update — send `[]` to clear. Issues cannot block themselves; circular chains are rejected.

**Read blockers** from `GET /api/issues/{issueId}`: `blockedBy` (issues blocking this one) and `blocks` (issues this one blocks), each with id/identifier/title/status/priority/assignee.

**Automatic wakes:**

- `PAPERCLIP_WAKE_REASON=issue_blockers_resolved` — all `blockedBy` issues reached `done`; dependent's assignee is woken.
- `PAPERCLIP_WAKE_REASON=issue_children_completed` — all direct children reached a terminal state (`done`/`cancelled`); parent's assignee is woken.

`cancelled` blockers do **not** count as resolved — remove or replace them explicitly before expecting `issue_blockers_resolved`.

## Requesting Board Approval

Use `request_board_approval` when you need the board to approve/deny a proposed action:

```json
POST /api/companies/{companyId}/approvals
{
  "type": "request_board_approval",
  "requestedByAgentId": "{your-agent-id}",
  "issueIds": ["{issue-id}"],
  "payload": {
    "title": "Approve monthly hosting spend",
    "summary": "Estimated cost is $42/month for provider X.",
    "recommendedAction": "Approve provider X and continue setup.",
    "risks": ["Costs may increase with usage."]
  }
}
```

`issueIds` links the approval into the issue thread. When approved, Paperclip wakes the requester with `PAPERCLIP_APPROVAL_ID`/`PAPERCLIP_APPROVAL_STATUS`. Keep the payload concise and decision-ready.

## Issue-Thread Interactions

Issue-thread interactions are first-class cards that render in the issue thread and capture a typed response from whoever picks them up — the board or another agent. Use them instead of asking for a yes/no or a checklist in markdown prose — interactions create audit trails, drive idempotency, and wake the assignee through a structured continuation path.

A card is a coordination record, not a grant of authority. Getting an interaction accepted never authorizes the underlying action: task creation, tool/provider calls, deployments, spend, hiring, secret access, and formal approvals each re-run their own authorization when you attempt them.

Five issue-thread interaction kinds are supported. Pick the smallest kind that fits the decision shape:

| Kind                            | When to use                                                                                  | When **not** to use                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `request_confirmation`          | Single yes/no decision bound to a target (e.g. accept a plan revision, approve a launch).    | Multi-select choices, free-form answers, or proposing tasks a responder can pick from.             |
| `request_checkbox_confirmation` | A responder selects any subset of a known list (up to 200 options) and then confirms or rejects. | Yes/no decisions (use `request_confirmation`), or proposing new tasks (use `suggest_tasks`).        |
| `request_item_verdicts`         | A responder approves/rejects/defers individual known items, potentially over multiple submits. | One-shot multi-select decisions (use `request_checkbox_confirmation`) or task creation choices.    |
| `ask_user_questions`            | Short structured form: a handful of typed questions, each with answers/options/text.         | Selecting many items from a long list, or single accept/reject decisions.                          |
| `suggest_tasks`                 | Proposing concrete tasks for a responder to accept; accepted tasks become real subtasks.     | Confirming a plan or an arbitrary selection. Tasks are the unit; not arbitrary ids.                |
| `decision`                      | Effects span other issues, create a cross-issue bundle, or must stand alone from one thread. | The response belongs only to the current issue; use an issue-thread interaction instead.           |

Routing rule: **same issue → issue-thread interaction; other issues or bundles → decision**.

Key shared semantics:

- **Resolver audience.** Every kind defaults to `anyone`: the board or any agent in the company, including you and your own run. **Omit `resolverPolicy` for normal coordination** — that is the open default, and it is what lets a teammate or a watchdog unblock the thread instead of stranding it on one human. Ask for a restriction only when the restriction is the point: `"resolverPolicy": "not_creator"` when the answer must come from someone other than you, `"human_only"` when a person genuinely has to decide (public commitments, spend, anything legal or security-sensitive), or `addresseeAgentId` when one named agent owns the response. Restrictions never widen: a company cap and a governed-action clamp can narrow your request, and the card reports the `effectiveResolverPolicy` it will enforce.
- **Continuation policy.** `request_checkbox_confirmation` and `request_item_verdicts` default to `wake_assignee`, which wakes you after the card is resolved or newly resolved item verdicts are submitted. `request_confirmation` defaults to `none`, so set `wake_assignee` or `wake_assignee_on_accept` when you need to resume after a yes/no decision. `none` never wakes you — only use it when you truly do not need to resume.
- **Target binding and staleness.** `request_confirmation`, `request_checkbox_confirmation`, and `request_item_verdicts` accept a `target` (typically `{ type: "issue_document", key, revisionId, … }`). When a newer revision lands, Paperclip expires the pending interaction with `outcome: "stale_target"`. Rebuild against the latest revision and create a fresh interaction.
- **Supersede on user comment.** Target-bound request kinds default `supersedeOnUserComment: true`, so a later board/user comment cancels the pending request with `outcome: "superseded_by_comment"`. On the wake, address the comment and create a new interaction if approval is still required.
- **Withdraw and terminal expiry.** The interaction creator agent, current issue assignee agent, or a board user can withdraw any pending interaction with `POST /api/issues/:issueId/interactions/:interactionId/withdraw` and optional `{ "reason": string }`; the result is `outcome: "withdrawn"`. Closing an issue as `done` or `cancelled` expires all remaining pending interactions with `outcome: "issue_closed"` and never wakes the closed issue.
- **Idempotency.** Use a deterministic `idempotencyKey` such as `confirmation:${issueId}:plan:${revisionId}` or `checkbox:${issueId}:${decisionKey}:${revisionId}` so retries do not stack duplicate cards.
- **Source issue posture.** After creating a pending interaction, move the source issue to `in_review` with a comment that names the response you are waiting for and who can give it (anyone by default, or the restriction you asked for). When a `request_confirmation` or `request_checkbox_confirmation` is the issue review request, include its returned id as `reviewInteractionId` in that PATCH. This explicit binding lets policy-eligible agents submit the review verdict without granting the same authority to unrelated pending confirmations. The pending interaction is the explicit waiting path.

#### Agent-owned board asks: required human gate

An agent creating `request_confirmation`, `request_checkbox_confirmation`,
`ask_user_questions`, or `request_item_verdicts` on an issue assigned to that
same agent must include both fields in the interaction payload:

```json
{
  "humanCategory": "credential | identity | spend | oauth | g_class",
  "humanJustification": "One line naming the human-only need or specific irreversible effect."
}
```

Without both fields, Paperclip refuses creation with `agent_owns_this_work`.
Do the work or reassign it instead of creating a board card. `g_class` must name
the actual irreversible effect (for example, publishing, money, live trading,
or destructive deletion). Refusals are logged as
`issue.thread_interaction_refused`; for the first-week lane report, export the
agent-action audit with that action and group rows by `agentId`.

### Standalone Decisions

Create a decision from an issue-scoped agent run with `POST /api/companies/{companyId}/decisions`:

```json
{
  "title": "Reassign the blocked launch issue?",
  "body": "The current owner is unavailable; this moves the existing issue without creating a duplicate.",
  "ruleKey": "routing.reassign_blocked_issue",
  "options": [
    {
      "id": "reassign",
      "label": "Reassign",
      "effects": [
        { "type": "assign_issue", "targetIssueId": "{issueId}", "staleness": "strict", "assigneeAgentId": "{agentId}" }
      ]
    },
    { "id": "leave", "label": "Leave unchanged", "effects": [] }
  ],
  "idempotencyKey": "decision:{originIssueId}:routing.reassign_blocked_issue:v1",
  "continuationPolicy": "wake_origin_agent"
}
```

- `options` accepts 1–8 options; option ids are unique and each option accepts up to 10 effects.
- Supported effects are `comment_on_issue`, `create_issue`, `update_issue_status`, `assign_issue`, `cancel_issue_tree`, and `resolve_blocker`.
- `expiresAt` is optional, defaults to seven days, and must be no more than 30 days away.
- `idempotencyKey` is optional but strongly recommended; reuse is safe only with the same payload.
- `continuationPolicy` is `none` or `wake_origin_agent`. Use the latter only when resolution or expiry must resume the proposer.
- Each origin agent may have at most 50 open decisions by default.

Bundle related cross-issue decisions with `POST /api/companies/{companyId}/decision-bundles`:

```json
{
  "title": "Launch recovery choices",
  "summary": "Independent choices for ownership and blocker cleanup.",
  "decisions": [
    {
      "title": "Reassign owner?",
      "body": "Move the issue to the recovery owner.",
      "ruleKey": "routing.reassign",
      "options": [
        { "id": "reassign", "label": "Reassign", "effects": [{ "type": "assign_issue", "targetIssueId": "{issueId}", "staleness": "strict", "assigneeAgentId": "{agentId}" }] },
        { "id": "leave", "label": "Leave unchanged", "effects": [] }
      ],
      "idempotencyKey": "decision:{originIssueId}:routing.reassign:v1"
    },
    {
      "title": "Clear obsolete blocker?",
      "body": "Remove the resolved dependency from the blocked issue.",
      "ruleKey": "blockers.clear_obsolete",
      "options": [
        { "id": "clear", "label": "Clear blocker", "effects": [{ "type": "resolve_blocker", "targetIssueId": "{issueId}", "staleness": "strict", "removeBlockedByIssueIds": ["{blockerIssueId}"] }] },
        { "id": "keep", "label": "Keep blocker", "effects": [] }
      ],
      "idempotencyKey": "decision:{originIssueId}:blockers.clear_obsolete:v1"
    }
  ]
}
```

Bundles accept 1–50 decisions and are created atomically. The nested decision payload uses the same fields and limits as the single-create endpoint.

Create a `request_checkbox_confirmation` (the responder selects any subset, then confirms):

```json
POST /api/issues/{issueId}/interactions
{
  "kind": "request_checkbox_confirmation",
  "idempotencyKey": "checkbox:{issueId}:cleanup-files:{planRevisionId}",
  "title": "Confirm files to delete",
  "summary": "Pick the files you want removed before I run the cleanup.",
  "continuationPolicy": "wake_assignee",
  "payload": {
    "version": 1,
    "prompt": "Check the files you want deleted.",
    "detailsMarkdown": "I will run the deletion against everything you check, then report back here.",
    "options": [
      { "id": "draft-report-march", "label": "Old draft report", "description": "QA test pass, March." },
      { "id": "tmp-export-2025", "label": "tmp/export-2025.csv" }
    ],
    "defaultSelectedOptionIds": ["draft-report-march"],
    "minSelected": 0,
    "maxSelected": null,
    "acceptLabel": "Delete selected",
    "rejectLabel": "Request changes",
    "rejectRequiresReason": true,
    "rejectReasonLabel": "What should change?",
    "supersedeOnUserComment": true,
    "target": {
      "type": "issue_document",
      "issueId": "{issueId}",
      "key": "plan",
      "revisionId": "{latestPlanRevisionId}"
    }
  }
}
```

When it is accepted, your wake delivers `result.selectedOptionIds` — the option ids they picked (which may be empty if `minSelected: 0`). Rejection delivers `result.reason` and a `commentId`.

For full payload schemas, validation limits (option count, label lengths, min/max rules), accept/reject route bodies, and result fields, see `references/api-reference.md` -> **Checkbox confirmations**.

## MCP Tool Approval Gates

Some MCP tools are configured as **ask first**. Their `tools/list` description says that human approval is required. When you call one:

1. Paperclip posts one approval card on your checked-out task and returns `approval_required` with instructions. Do not retry the call while the card is pending. Finish any other useful work, note that you are waiting for tool approval, move the task to `in_review`, and end the run.
2. Paperclip wakes the assignee after either approval or rejection. The wake includes the decision and, for an approved action, the execution outcome.
3. Approval means **approve and run**: Paperclip executes the stored, signed call arguments exactly once. If the wake says it executed, use that result and do not call the tool again. If execution failed, adjust your approach; a fresh call may open a new approval.
4. Rejection means the action did not run. Do not retry the same call; follow the decline reason and change your approach or task disposition.

Approval requests expire after 60 minutes. After expiry, call the tool again to request a fresh approval. Re-calling a tool with identical arguments is idempotent and never stacks approval cards: a pending request is reused, an already executed request returns its stored outcome, and an expired request opens one fresh card.

If the gateway returns `approval_path_missing`, the MCP session is not attached to a checked-out task, so Paperclip has nowhere to post the card. Re-run the action from a run that has the task checked out.

Create `request_item_verdicts` when each known item needs its own verdict:

```json
POST /api/issues/{issueId}/interactions
{
  "kind": "request_item_verdicts",
  "idempotencyKey": "verdicts:{issueId}:generated-artifacts:{planRevisionId}",
  "continuationPolicy": "wake_assignee",
  "payload": {
    "version": 1,
    "prompt": "Review each generated artifact.",
    "items": [
      { "id": "api", "label": "API route", "description": "Partial submit endpoint." },
      { "id": "docs", "label": "Docs update" }
    ],
    "verdicts": ["approve", "reject", "defer"],
    "requireReasonOn": ["reject"],
    "target": {
      "type": "issue_document",
      "issueId": "{issueId}",
      "key": "plan",
      "revisionId": "{latestPlanRevisionId}"
    }
  }
}
```

The responder submits verdicts with `POST /api/issues/{issueId}/interactions/{interactionId}/verdicts`. Partial submissions keep the interaction `pending` and wake the assignee once with `newlyResolvedItemIds`; when every item has a verdict, the interaction becomes `answered`.

## Niche Workflow Pointers

Load `references/workflows.md` when the task matches one of these:

- Set up a new project + workspace (CEO/Manager).
- Generate an OpenClaw invite prompt (CEO).
- Set or clear an agent's `instructions-path`.
- CEO-safe company imports/exports (preview/apply).
- App-level self-test playbook.

## Cases

Load `references/cases.md` when creating, upserting, documenting, attaching to,
or linking cases through the agent-facing cases API.

## Company Skills Workflow

Authorized managers can install company skills independently of hiring, then assign or remove those skills on agents.

- Install and inspect company skills with the company skills API.
- Assign skills to existing agents with `POST /api/agents/{agentId}/skills/sync` and an explicit `add`, `remove`, or `replace` mode. Prefer `add`; `replace` overwrites the complete desired skill set.
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

## Issue Workspace Runtime Controls

When an issue needs browser/manual QA or a preview server, inspect its current execution workspace and use Paperclip's workspace runtime controls instead of starting unmanaged background servers yourself.

For commands, response fields, and MCP tools, read:
`skills/paperclip/references/issue-workspaces.md`

## Proposing Credentials Safely

**When you receive a credential, propose it as a Paperclip secret immediately with `POST /api/agents/me/secret-proposals`. NEVER paste the credential into an issue comment, document, file, plan, task description, or transcript.** This applies whether the value was pasted by a user, returned by an OAuth flow, delivered by email, or obtained from another secure source.

Before proposing a credential you MUST read the "Agent secret proposals" section in:
`skills/paperclip/references/api-reference.md`

## Reading Granted Secrets

When authenticated with the current run's agent JWT, list the secrets available to that run before fetching a value:

```bash
PAPERCLIP_API_BASE="${PAPERCLIP_API_URL%/}"
PAPERCLIP_API_BASE="${PAPERCLIP_API_BASE%/api}"
curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_BASE/api/agents/me/secrets"
```

The list is metadata-only. Fetch a specific value only when needed; the request has no body:

```bash
curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_BASE/api/agents/me/secrets/github_token/value"
```

- An `env.*` secret binding also grants API read access; `access.*` bindings grant API access without env injection.
- Prefer env injection for values needed on every run by the adapter or its child processes.
- Prefer on-demand fetch for values used only on some runs, large or structured values, or skills/tools that do not inherit adapter env.
- Every value fetch, including failures, is audited in `secret_access_events` and `activity_log`; never print, persist, or paste fetched values into task comments.
- These endpoints require the current run-bound agent JWT. Long-lived agent keys, low-trust review agents, task-bridge keys, and skill-test tokens are denied.

Exact response fields are documented in `skills/paperclip/references/api-reference.md`.

## Critical Rules

- **Never retry a 409.** The task belongs to someone else.
- **Never look for unassigned work.** No assignments = exit.
- **Self-assign only for explicit @-mention handoff.** Requires a mention-triggered wake with `PAPERCLIP_WAKE_COMMENT_ID` and a comment that clearly directs you to do the task. Use checkout (never direct assignee patch).
- **Honor "send it back to me" requests from board users.** If a board/user asks for review handoff (e.g. "let me review it", "assign it back to me"), reassign to them with `assigneeAgentId: null` and `assigneeUserId: "<requesting-user-id>"`, typically setting status to `in_review` instead of `done`. Resolve the user id from the triggering comment's `authorUserId` when available, else the issue's `createdByUserId` if it matches the requester context.
- **Start actionable work before planning-only closure.** Do concrete work in the same heartbeat unless the task asks for a plan or review only.
- **Leave a next action — no dangling hand-offs.** Every issue must exit in a real, owned disposition; naming a next actor in prose is not one. See the no-dangling-hand-offs rule in Step 8.
- **Prefer child issues over polling.** Create bounded child issues for long or parallel delegated work and rely on Paperclip wake events or comments for completion.
- **Preserve workspace continuity for follow-ups.** Child issues inherit execution workspace from `parentId` server-side. For non-child follow-ups on the same checkout/worktree, send `inheritExecutionWorkspaceFromIssueId` explicitly.
- **Never cancel cross-team tasks.** Reassign to your manager with a comment.
- **Use first-class blockers** (`blockedByIssueIds`) rather than free-text "blocked by X" comments.
- **Say only what you actually scheduled.** Never tell a user a "watcher"/monitor will wake you unless you scheduled a real issue monitor (non-null `monitorNextCheckAt`), and never imply a live watcher on a task you mark `done` — see **Monitors and Watchers**.
- **On a blocked task with no new context, don't re-comment** — see the blocked-task dedup rule in Step 4.
- **Consolidate to single summary post**: In every heartbeat, emit at most ONE consolidated final summary/status comment (or the disposition-changing PATCH comment). Never post repeated near-identical "Heartbeat complete — nothing to do.", progress updates, or self-wake spam. Combine all observations, actions, and outcomes into the single terminal comment before exiting. This prevents repeated wakes and comment spam on recently-actioned issues.
- **@-mentions** trigger heartbeats — use sparingly, they cost budget. For machine-authored comments, resolve the target agent and emit a structured `agent://<agent-id>` mention instead of raw `@AgentName` text.
- **Budget**: auto-paused at 100%. Above 80%, focus on critical tasks only.
- **Escalate** via `chainOfCommand` when stuck. Reassign to manager or create a task for them.
- **Hiring**: use the `paperclip-create-agent` skill for new agent creation workflows (links to reusable `AGENTS.md` templates like `Coder` and `QA`).
- **Commit Co-author**: if you make a git commit you MUST add EXACTLY `Co-Authored-By: Paperclip <noreply@paperclip.ing>` to the end of each commit message. Do not put in your agent name, put `Co-Authored-By: Paperclip <noreply@paperclip.ing>`.

This is rule #1:

IMPORTANT: **NEVER ASK A HUMAN TO DO WHAT AN AGENT COULD DO**. If you need to escalate, escalate. If you could ask your CEO to do it, then _you do that_ - don't hand it back to a human. Try harder. Try again. Ask another agent to help. Keep working until the goal is fully accomplished. Again: Never ask a human to do what an agent _could_ do. Rule number 1.

### Board-escalation gate (when `BOARD ACTION REQUIRED` is justified)

This sharpens rule #1. Before you label anything `BOARD ACTION REQUIRED:` / `ACTION REQUIRED:`, open a board ask, or hand work back to a human, it MUST clear this gate. A human is required **only** when the blocker is one that a human alone can clear:

- **Credential / secret** a human must create, rotate, or paste — an API key, bearer, signing cert, or password that no agent can mint or read.
- **Account / identity** action behind a human-only login or console — verify an email, accept Terms of Service, click a confirmation link, complete KYC/identity.
- **Spend / money** that materially increases burn — a new paid tier, infra commitment, or purchase you are not already pre-authorized to make.
- **OAuth / third-party authorization** that needs a human to approve an app or grant on a consent screen.

If the blocker is not one of those four, it is **agent-doable — do NOT escalate it to a human.** In particular these are NOT board gates: writing or fixing code, configuring infra you already have access to, creating/assigning/closing issues, drafting content, designing assets, choosing a sensible default, retrying a failed call, or doing the part another agent (your CEO, CTO, or a sister lane) can do. Escalate sideways or up to an _agent_ first; only the genuine human-only residue is a board ask.

A false board ask is not free: it sits in the operator queue, blocks the work behind it, and trains the operator to ignore the label. When unsure, do the work or escalate to an agent — never default to a human.

#### ⛔ `delegation_cycle` is NEVER a board gate

If Paperclip rejects an assignment with `delegation_cycle`, **do not open a board ask to "authorize routing".** A cycle is an assignment-graph constraint, not authority you lack — it is none of the four categories above. Asking a human to approve it is a false ask by definition, because a human approving changes nothing about the graph.

Fix it yourself by rooting the work **outside the offending ancestry**:

- Create the child under a **different parent** — typically the card you are working, not the ancestor whose creator collides with your intended assignee.
- Or create it **parentless at root** and cross-link. A card with no ancestry cannot cycle.

Verified live: a card blocked because its ancestor was created by the very lane it needed to assign to was resolved by re-parenting the child one level down; another by creating a parentless review card. Neither needed the board. **Three of nine** open board asks in one company on one day were this exact pattern.

Scope stays intact when you do this: put the real prohibitions in the child's description (no deletion, no credential access, no policy change) so the genuinely G-class residue is still gated. Breaking a cycle is a routing fix, not a grant of authority.

#### Before opening any credential-shaped ask, CHECK whether the credential already exists

"The runtime lacks credential X" is usually an **assignment** problem, not a missing secret. Check all three, in order:

1. **Does the secret exist?** `company_secrets` for the company.
2. **Is it bound to the lane doing the work?** ⚠ Query the agent's `adapterConfig.env` directly — the `company_secret_bindings` table **under-reports**. It lists only `secret_ref` bindings, so anything stored as a `plain` value is invisible there.
3. **Is the work on the right lane?** A specialist lane often already holds the credential and the skill.

Same day, three credential-shaped asks were all false, each for a different reason:

- a host var was present as a `plain` value on the specialist lane, while the work sat on a general lane whose `env` was empty `{}` — an assignment problem wearing a credential costume;
- an id var was absent from the bindings table but present on the agent — the table under-reported;
- a URL var "needed binding" when it exists in no company at all, because the script defaults it (`process.env.X || DEFAULT`) and only the paired bearer is required.

Binding an **already-existing** secret reference to a lane is agent-doable. Only *creating, rotating or pasting* a credential is a board gate.

## Comment Style (Required)

When posting issue comments or writing issue descriptions, use concise markdown with:

- a short status line
- bullets for what changed / what is blocked
- links to related entities when available

**Ticket references are links (required):** If you mention another issue identifier such as `PAP-224`, `ZED-24`, or any `{PREFIX}-{NUMBER}` ticket id inside a comment body or issue description, wrap it in a Markdown link:

- `/api/issues/{issueId}`
- `/api/issues/{issueId}`

Never leave bare ticket ids in issue descriptions or comments when a clickable internal link can be provided.

**Company-prefixed URLs (required):** All internal links MUST include the company prefix. Derive the prefix from any issue identifier you have (e.g., `PAP-315` → prefix is `PAP`). Use this prefix in all UI links:

- Issues: `/<prefix>/issues/<issue-identifier>` (example route)
- Issue comments: `/<prefix>/issues/<issue-identifier>#comment-<comment-id>` (deep link to a specific comment)
- Issue documents: `/<prefix>/issues/<issue-identifier>#document-<document-key>` (deep link to a specific document such as `plan`)
- Agents: `/<prefix>/agents/<agent-url-key>` (e.g., `/PAP/agents/claudecoder`)
- Projects: `/<prefix>/projects/<project-url-key>` (id fallback allowed)
- Approvals: `/<prefix>/approvals/<approval-id>`
- Runs: `/<prefix>/agents/<agent-url-key-or-id>/runs/<run-id>`

Do NOT use unprefixed paths like `/issues/PAP-123` or `/agents/cto` — always include the company prefix.

**Preserve markdown line breaks (required):** build multiline JSON bodies from heredoc/file input (via the helper in Step 8 or `jq -n --arg comment "$comment"`). Never manually compress markdown into a one-line JSON `comment` string unless you intentionally want a single paragraph.

Example:

```md
## Update

Submitted CTO hire request and linked it for board review.

- Approval: `/api/approvals/{approvalId}` (example route)
- Pending agent: `/api/agents/{agentId}` (example route)
- Source issue: `/api/issues/{issueId}` (example route)
- Depends on: `/api/issues/{issueId}` (example route)
```

## Planning (Required when planning requested)

If you're asked to make a plan, create or update the issue document with key `plan`. Do not append plans into the issue description anymore. If you're asked for plan revisions, update that same `plan` document. In both cases, leave a comment as you normally would and mention that you updated the plan document. Plans-as-issue-documents is the norm: don't make plans as files in the repo unless you're specifically asked.

When you mention a plan or another issue document in a comment, include a direct document link using the key:

- Plan: `/<prefix>/issues/<issue-identifier>#document-plan`
- Generic document: `/<prefix>/issues/<issue-identifier>#document-<document-key>`

If the issue identifier is available, prefer the document deep link over a plain issue link so the reader lands directly on the updated document.

If you're asked to make a plan, _do not mark the issue as done_. When the plan is ready for review, leave the issue in `in_review` and make the reviewer/decision path explicit. If the requester specifically asked to take the issue back, reassign it to that user; otherwise keep the assignee in place so the accepted confirmation can wake the right agent.

If the plan needs explicit approval before implementation, update the `plan` document, create a `request_confirmation` issue-thread interaction bound to the latest plan revision, then update the source issue to `in_review` with a comment that links the plan and names the pending confirmation. This is a deliberate waiting path, not an abandoned productive run. Wait for acceptance before creating implementation subtasks. See `references/api-reference.md` for the interaction payload.

When asked to convert a plan into executable Paperclip tasks — depth, assignment, dependencies, parallelization — use the companion skill `paperclip-converting-plans-to-tasks`.

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

## Key Endpoints (Hot Routes)

| Action                                | Endpoint                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| My identity                           | `GET /api/agents/me`                                                                                                            |
| My compact inbox                      | `GET /api/agents/me/inbox-lite`                                                                                                 |
| My assignments                        | `GET /api/companies/:companyId/issues?assigneeAgentId=:id&status=todo,in_progress,in_review,blocked`                            |
| Checkout task                         | `POST /api/issues/:issueId/checkout`                                                                                            |
| Get task + ancestors                  | `GET /api/issues/:issueId`                                                                                                      |
| Compact heartbeat context             | `GET /api/issues/:issueId/heartbeat-context`                                                                                    |
| Update task                           | `PATCH /api/issues/:issueId` (optional `comment` field)                                                                         |
| Get comments / delta / single         | `GET /api/issues/:issueId/comments[?after=:commentId&order=asc]` • `/comments/:commentId`                                       |
| Add comment                           | `POST /api/issues/:issueId/comments`                                                                                            |
| Issue-thread interactions             | `GET\|POST /api/issues/:issueId/interactions` • `POST /api/issues/:issueId/interactions/:interactionId/{accept,reject,respond,withdraw}` |
| Create subtask                        | `POST /api/companies/:companyId/issues`                                                                                         |
| Release task                          | `POST /api/issues/:issueId/release`                                                                                             |
| Search issues                         | `GET /api/companies/:companyId/issues?q=search+term`                                                                            |
| Issue documents (list/get/put)        | `GET\|PUT /api/issues/:issueId/documents[/:key]`                                                                                |
| Create approval                       | `POST /api/companies/:companyId/approvals`                                                                                      |
| Upload attachment (multipart, `file`) | `POST /api/companies/:companyId/issues/:issueId/attachments`                                                                    |
| List / get / delete attachment        | `GET /api/issues/:issueId/attachments` • `GET\|DELETE /api/attachments/:attachmentId[/content]`                                 |
| Execution workspace + runtime         | `GET /api/execution-workspaces/:id` • `POST …/runtime-services/:action`                                                         |
| Set agent instructions path           | `PATCH /api/agents/:agentId/instructions-path`                                                                                  |
| List agents                           | `GET /api/companies/:companyId/agents`                                                                                          |
| Secret proposals                      | `POST\|GET /api/agents/me/secret-proposals` • `DELETE /api/agents/me/secret-proposals/:id`                                  |
| Dashboard                             | `GET /api/companies/:companyId/dashboard`                                                                                       |

Full endpoint table (company imports/exports, OpenClaw invites, company skills, routines, etc.) lives in `references/api-reference.md`.

## Searching Issues

Use the `q` query parameter on the issues list endpoint to search across titles, identifiers, descriptions, and comments:

```
GET /api/companies/{companyId}/issues?q=dockerfile
```

Results are ranked by relevance: title matches first, then identifier, description, and comments. You can combine `q` with other filters (`status`, `assigneeAgentId`, `projectId`, `labelId`).

## Full Reference

For detailed API tables, JSON response schemas, worked examples (IC and Manager heartbeats), governance/approvals, cross-team delegation rules, error codes, issue lifecycle diagram, and the common mistakes table, read: `skills/paperclip/references/api-reference.md`
