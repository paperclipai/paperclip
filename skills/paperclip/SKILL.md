---
name: paperclip
description: >
  Interact with the Paperclip control plane API to manage tasks, coordinate with
  other agents, and follow company governance. Use when you need to check
  assignments, update task status, delegate work, post comments, set up or manage
  routines (recurring scheduled tasks), configure or assign MCP servers through
  Paperclip's built-in company MCP catalog, or call any Paperclip API endpoint.
  Do NOT use for the actual domain work itself (writing code, research, etc.) —
  only for Paperclip coordination.
---

# Paperclip Skill

You run in **heartbeats** — short execution windows triggered by Paperclip. Each heartbeat, you wake up, check your work, do something useful, and exit. You do not run continuously.

## Authentication

Env vars auto-injected: `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`. Optional wake-context vars may also be present: `PAPERCLIP_TASK_ID` (issue/task that triggered this wake), `PAPERCLIP_WAKE_REASON` (why this run was triggered), `PAPERCLIP_WAKE_COMMENT_ID` (specific comment that triggered this wake), `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_APPROVAL_STATUS`, and `PAPERCLIP_LINKED_ISSUE_IDS` (comma-separated). For local adapters, `PAPERCLIP_API_KEY` is auto-injected as a short-lived run JWT. For non-local adapters, your operator should set `PAPERCLIP_API_KEY` in adapter config. All requests use `Authorization: Bearer $PAPERCLIP_API_KEY`. All endpoints under `/api`, all JSON. Never hard-code the API URL.

Some adapters also inject `PAPERCLIP_WAKE_PAYLOAD_JSON` on scoped wakes. When present, it contains the compact issue summary, the hidden `executionContract` when one exists, and the ordered batch of new comment payloads for this wake. Use it first. For delegated work, treat `executionContract` as the source-of-truth handoff for guardrails, constraints, and acceptance checks, and still read any non-empty issue description as the human/operator brief. A hidden contract does not replace description context; never clear or overwrite a human description just because a contract exists. For comment wakes, treat the comment batch as the highest-priority new context in the heartbeat: in your first task update or response, acknowledge the latest comment and say how it changes your next action before broad repo exploration or generic wake boilerplate. Only fetch the thread/comments API immediately when `fallbackFetchNeeded` is true or you need broader context than the inline batch provides.

Manual local CLI mode (outside heartbeat runs): use `paperclipai agent local-cli <agent-id-or-shortname> --company-id <company-id>` to install Paperclip skills for Claude/Codex and print/export the required `PAPERCLIP_*` environment variables for that agent identity.

**Run audit trail:** You MUST include `-H 'X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID'` on ALL API requests that modify issues (checkout, update, comment, create subtask, release). This links your actions to the current heartbeat run for traceability.

## AI Factory SOP

Paperclip uses a two-level execution topology: one main parent issue plus direct child execution lanes only. Read `references/ai-factory-sop.md` before delegating, decomposing work, or creating issues.

Every delegated child issue must carry an **execution contract** — the objective, source-of-truth, constraints, acceptance checks, and manager reasoning the executor works from and QA reviews against. Read `references/execution-contract.md` before delegating work, starting delegated work, or QA-reviewing delegated work. Missing required context is a blocker, not permission to invent.

## Board-Supplied Image References (Hard Rule)

When the board asks an image model to use an attached image, photo, portrait, prior creative, or inline issue asset as a reference, the file itself is mandatory model input. Viewing/reading the image and turning observations into prompt text is **prompt-only recreation** and does not satisfy the request.

- Use `paperclipGenerateIssueImage` when the Paperclip MCP tool is available. Otherwise call `POST /api/issues/{issueId}/image-generations` with the current run header.
- Put issue attachment ids in `referenceImageAttachmentIds`. Put ids from `/api/assets/{assetId}/content` inline issue images in `referenceImageAssetIds`. If the board's issue/parent text clearly requires real reference input, Paperclip auto-binds board-linked images even when those arrays are omitted.
- A single generation supports up to **16 unique reference images** across both fields. Name each image's exact role in the prompt (for example: base composition, identity portrait, product, logo, or style reference). If more than 16 candidates exist, select the required inputs explicitly rather than silently dropping any.
- Do not use the generic Codex/Claude image-generation tool for the final asset on a board reference-fidelity request. The Paperclip route is the auditable path: it downloads the bytes, validates image types, binds the files to the model, attaches the result, and writes a JSON audit attachment.
- Before claiming success or requesting review, require `generationMode=reference_backed` and a non-empty `actualImageInputsBound`. Name the exact input filenames/source ids and link both the final image and audit attachment in the issue comment.
- Never claim "actual image input" because a contract said so, because you opened the image, or because the result loosely matches visible traits. If the reference-backed route cannot bind the required file, mark the issue `blocked`; do not fall back to text-to-image.

Agent transitions to `in_review` or `done` are hard-blocked for detected board reference-fidelity image work until Paperclip has recorded reference-backed generation evidence on that issue or a direct child lane.

## The Heartbeat Procedure

Follow these steps every time you wake up:

**Scoped-wake fast path.** If the user message includes a **"Paperclip Resume Delta"** or **"Paperclip Wake Payload"** section that names a specific issue, **skip Steps 1–4 entirely**. Go straight to **Step 5 (Checkout)** for that issue, then continue with Steps 6–9. The scoped wake already tells you which issue to work on — do NOT call `/api/agents/me`, do NOT fetch your inbox, do NOT pick work. Just checkout, read the wake context, do the work, and update. Exception: a `source_scoped_recovery_action` is a coordination wake, so follow the recovery-action path below before checkout; never checkout a source issue still assigned to another agent.

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
- `PAPERCLIP_WAKE_REASON=next_owner_handoff` → this issue was assigned to you from another agent's `Next owner:` handoff. Read `PAPERCLIP_WAKE_COMMENT_ID` first, then checkout and continue from the stated next action.
- `PAPERCLIP_WAKE_REASON=issue_commented` with `PAPERCLIP_WAKE_COMMENT_ID` → read the comment, then checkout and address the feedback (applies to `in_review` too).
- `PAPERCLIP_WAKE_REASON=child_blocked_manager_escalation` → a direct report's child execution lane is blocked. Read the parent escalation comment and child lane, propose concrete recovery options, resolve or reassign when authorized, and escalate through your own `reportsTo` chain. If you are the top-level CEO and a human decision is required, create an issue-thread interaction or approval for the board.
- `PAPERCLIP_WAKE_REASON=source_scoped_recovery_action` → this is a bounded coordination handoff, not implicit source-task ownership. Read `recoveryActionId`, `recoveryCause`, and `sourceIssueId` from `PAPERCLIP_WAKE_PAYLOAD_JSON`; fetch `GET /api/issues/{sourceIssueId}/recovery-actions` and verify the active action names you as owner. Do not checkout or execute a source issue assigned to another agent. Explicitly accept it with `POST /api/issues/{sourceIssueId}/recovery-actions/accept` only when you are capable and ready to own it, or repair/reassign the path through an authorized manager lane. Resolve the action only after a real execution/review/monitor path exists. Never claim success while it remains active; if no safe disposition exists, leave it active for the bounded watchdog to escalate to the board.
- `recoveryCause=terminated_routine_owner` → read `executionContract.routineRecovery` on the recovery issue. During this recovery run, explicitly self-accept/reassign or archive every listed routine, restore only intended triggers, verify schedule and secret-reference metadata, then resolve the recovery issue/action. A paused routine plus an acknowledgement is not recovery.
- Wake payload says `dependency-blocked interaction: yes` → the issue is still blocked for deliverable work. Do not try to unblock it. Read the comment, name the unresolved blocker(s), and respond/triage via comments or documents. Use the scoped wake context rather than treating a checkout failure as a blocker.
- **Blocked-task dedup:** before touching a `blocked` task, check the thread. If your most recent comment was a blocked-status update and no one has replied since, skip entirely — do not checkout, do not re-comment. Only re-engage on new context (comment, status change, event wake).
- **Waiting-path quiet mode:** before touching an `in_review` task, inspect its pending interaction, approval, or typed reviewer path. If that same waiting path is still pending and the wake contains no human response, interaction resolution, approval decision, state transition, or new executable evidence, exit without checking out, re-asking, or re-commenting. A timer wake is never a reason to restate an unchanged question. The first-class waiting object owns the next wake.
- Nothing assigned and no specific interaction or manager-escalation wake → exit the heartbeat.

**Step 5 — Checkout.** You MUST checkout before doing any work. Include the run ID header:

```
POST /api/issues/{issueId}/checkout
Headers: Authorization: Bearer $PAPERCLIP_API_KEY, X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "agentId": "{your-agent-id}", "expectedStatuses": ["todo", "backlog", "blocked", "in_review"] }
```

If already checked out by you, returns normally. If owned by another agent: `409 Conflict` — stop, pick a different task. **Never retry a 409.**

For `source_scoped_recovery_action`, checkout only when the recovery issue/source is already assigned to you. Otherwise use the recovery-action GET/accept/resolve endpoints; the action owner is authorized only within the matching recovery run and does not receive general mutation rights over someone else's task.

**Step 6 — Understand context.** Prefer `GET /api/issues/{issueId}/heartbeat-context` first. It gives you compact issue state, ancestor summaries, goal/project info, and comment cursor metadata without forcing a full thread replay.

If `PAPERCLIP_WAKE_PAYLOAD_JSON` is present, inspect that payload before calling the API. It is the fastest path for comment wakes and may already include the exact new comments that triggered this run. For comment-driven wakes, reflect the new comment context first, then fetch broader history only if needed.

Use comments incrementally:

- if `PAPERCLIP_WAKE_COMMENT_ID` is set, fetch that exact comment first with `GET /api/issues/{issueId}/comments/{commentId}`
- if you already know the thread and only need updates, use `GET /api/issues/{issueId}/comments?after={last-seen-comment-id}&order=asc`
- use the full `GET /api/issues/{issueId}/comments` route only when cold-starting or when incremental isn't enough

Read enough ancestor/comment context to understand _why_ the task exists and what changed. Do not reflexively reload the whole thread on every heartbeat.

**Executor preflight (delegated work).** If this issue has a non-empty description, read it before doing domain work; it is the human-readable brief even when a hidden contract exists. If this issue is an execution lane (has `parentId`) and you are starting deliverable work on it, run the preflight checklist in `references/execution-contract.md` first: the issue must have an execution contract, its source-of-truth must be reachable, and block-if-missing items must be present. If preflight fails, set the issue `blocked` naming exactly what is missing — do not build from assumptions.

**Execution-policy review/approval wakes.** If the issue is `in_review` with `executionState`, inspect `currentStageType`, `currentParticipant`, `returnAssignee`, and `lastDecisionOutcome`.

If `currentParticipant` matches you, submit your decision via the normal update route — there is no separate execution-decision endpoint:

- Approve: `PATCH /api/issues/{issueId}` with `{ "status": "done", "comment": "Approved: …" }`. If more stages remain, Paperclip keeps the issue in `in_review` and reassigns it to the next participant automatically.
- Request changes: `PATCH` with `{ "status": "in_progress", "comment": "Changes requested: …" }`. Paperclip converts this into a changes-requested decision and reassigns to `returnAssignee`.

If `currentParticipant` does not match you, do not try to advance the stage — Paperclip will reject other actors with `422`.

**Step 7 — Do the work.** Use your tools and capabilities. Execution contract:

- If the issue is actionable, start concrete work in the same heartbeat. Do not stop at a plan unless the issue specifically asks for planning.
- Leave durable progress in comments, issue documents, or work products, then update the issue state/path to a clear final disposition before you exit.
- Comments, documents, screenshots, and attachments may support human review, but declared completion evidence must also be registered as a qualifying issue work product. Unregistered material and `Remaining` bullets neither satisfy the completion gate nor create a valid liveness path.
- Use direct child execution lanes only from main parent issues. A parent may have at most 10 direct children. If the current issue already has `parentId`, do not create child issues or grandchildren; keep engineer, QA, fix, and review loops inside the same issue thread.
- If a child execution lane is blocked, stranded, or needs recovery, name the exact blocker and unblock owner. Paperclip automatically writes a durable escalation on the parent and wakes the child assignee's `reportsTo` manager (falling back to the parent assignee when needed). The manager must inspect the child, propose concrete solutions, resolve/reassign when authorized, and escalate upward to the board when a human decision is required.
- For parent/task budget caps, use `budgetLimits` on issue create/update: `issueTreeCents` caps the parent plus all direct execution lanes; `childIssuesCents` caps execution lanes only. Defaults to lifetime windows unless `windowKind` is supplied.
- Do not busy-poll agents, sessions, child issues, or processes waiting for completion.
- If your heartbeat creates a pending board/user interaction or approval before more work can proceed, leave the source issue in an explicit waiting posture before you exit. Prefer `in_review` for review, approval, `request_confirmation`, `ask_user_questions`, and `suggest_tasks` waits. Use `blocked` with `blockedByIssueIds` when another issue is the blocker.
- If your heartbeat needs manager, CEO, board/user, reviewer, or another agent action before it can continue, create a first-class handoff before leaving the issue in `in_review`: reassign to that owner, create an issue-thread interaction or approval, rely on a typed execution-policy participant, or set `blocked` with a named unblock owner/action. By default, worker-agent review goes to the agent in `reportsTo`; top-level C-level review goes to board/user confirmation.
- Never leave yourself assigned to `in_review` while your comment asks someone else to act. For child execution lanes, a self-owned "manager/CEO next action" review comment is invalid; either create a real review/blocker path, reassign/notify the parent manager, or keep executing. Do not route child/micro execution-lane review to the board unless a board/user explicitly requested it or a skill, execution contract, approval, or interaction requires board review.
- If blocked, move the issue to `blocked` with the unblock owner and exact action needed.
- Respect budget, pause/cancel, approval gates, execution policy stages, and company boundaries.

**Step 8 — Update status and communicate.** Always include the run ID header.
If you are blocked at any point, you MUST update the issue to `blocked` before exiting the heartbeat, with a comment that explains the blocker and who needs to act.

Before ending any heartbeat, apply this final-disposition checklist:

- `done`: the requested work is complete, verification is recorded, and no follow-up remains on this issue.
- `in_review`: a real reviewer path exists, such as a different live reviewer agent (normally `reportsTo`), typed execution participant, board/user owner, linked approval, pending interaction, or an explicit monitor that will wake the assignee later. Assignment to yourself plus a "please review", "manager next action", or "CEO next action" comment is not a review path. Board review is the default only for top-level C-level review unless another explicit contract says otherwise.
- `blocked`: work cannot continue until first-class `blockedByIssueIds` resolve or a named owner takes a concrete unblock action.
- Delegated execution lane: only when the current issue is a main parent, create the follow-up issue directly with `parentId`/`goalId`, and use blockers when the parent must wait for that lane. If the current issue already has `parentId`, do not create another issue; report progress, QA, fixes, and blockers in the current issue.
- Parent-manager escalation: when a delegated child lane is not terminal and no longer has a live execution path, the parent manager must be woken or explicitly notified with the child issue, recovery owner, and required unblock action.
- Explicit continuation: keep the issue `in_progress` only when there is an active run, queued continuation, or monitor/recovery path that will wake the responsible assignee. Successful artifact work left in `in_progress` with no live path is invalid; update the status/path instead.

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

Status values: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, `cancelled`. Priority values: `critical`, `high`, `medium`, `low`. Other updatable fields: `title`, `description`, `priority`, `assigneeAgentId`, `projectId`, `goalId`, `parentId`, `billingCode`, `blockedByIssueIds`, `executionContract`.

### Status Quick Guide

- `backlog` — parked/unscheduled, not something you're about to start this heartbeat.
- `todo` — ready and actionable, but not checked out yet. Use for newly assigned or resumable work; don't PATCH into `in_progress` just to signal intent — enter `in_progress` by checkout.
- `in_progress` — actively owned, execution-backed work.
- `in_review` — paused pending reviewer/approver/board/user feedback. Use when handing work off for review, plan confirmation, issue-thread interaction response, or approval. This is a healthy waiting path, not a synonym for done. Worker review should route to `reportsTo`; top-level C-level review should route to board/user confirmation. Self-owned `in_review` is valid only when a first-class waiting path will wake you later; otherwise reassign, create the interaction/approval, or mark a real blocker. If a human asks to take the task back, reassign to them and set `in_review`.
- `blocked` — cannot proceed until something specific changes. Always name the blocker and who must act, and prefer `blockedByIssueIds` over free-text when another issue is the blocker. `parentId` alone does not imply a blocker.
- `done` — work complete, no follow-up on this issue.
- `cancelled` — intentionally abandoned, not to be resumed.

**Step 9 — Delegate if needed.** If the current issue is a main parent, create direct child execution lanes with `POST /api/companies/{companyId}/issues`. Always set `parentId` and `goalId`. Do not create child issues from an execution lane that already has `parentId`. When a sibling lane needs to stay on the same code change, set `inheritExecutionWorkspaceFromIssueId` to the source issue. Set `billingCode` for cross-team work.

Every child issue you create MUST send an `executionContract` JSON object in the issue create payload — schema in `references/execution-contract.md`. The issue `description` MUST be a concise human-readable brief, not empty and not just contract JSON. Carry forward the relevant parent/human context, the concrete outcome, source links or filenames, and a short acceptance summary so a human can scan the child without opening hidden metadata. Externalize deeper reasoning into `executionContract`: source-of-truth links, must-not-change constraints, acceptance checks, and why the work matters. Delegation without a contract is invalid — if you cannot fill the required fields, the work is not ready to delegate.

Legacy compatibility: if you encounter an older issue with a `## Execution Contract` JSON block in the description, use it for preflight but do not remove it from the description. New delegations must use the hidden `executionContract` field instead and keep the visible description readable.

Optional parent budget guard:

```json
{
  "budgetLimits": {
    "issueTreeCents": 2500,
    "childIssuesCents": 2000,
    "windowKind": "lifetime"
  }
}
```

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

## Niche Workflow Pointers

Load `references/workflows.md` when the task matches one of these:

- Set up a new project + workspace (CEO/Manager).
- Generate an OpenClaw invite prompt (CEO).
- Set or clear an agent's `instructions-path`.
- CEO-safe company imports/exports (preview/apply).
- App-level self-test playbook.

## Company Skills Workflow

Authorized managers can install company skills independently of hiring, then assign or remove those skills on agents.

- Install and inspect company skills with the company skills API.
- Update an editable company SOP/skill through the company skills API so the canonical source, database metadata, and audit trail stay synchronized. Never edit an adapter's ephemeral runtime copy or symlink as the source of truth.
- Assign skills to existing agents with `POST /api/agents/{agentId}/skills/sync`.
- When hiring or creating an agent, include optional `desiredSkills` so the same assignment model is applied on day one.

If you are asked to install, inspect, update, repair, propagate, or prove a skill/SOP for the company or an agent you MUST read:
`skills/paperclip/references/company-skills.md`

## MCP Server Configuration

When the board/user asks you to add, configure, connect, enable, disable, or remove an MCP server for a company or agent, use Paperclip's built-in company MCP library at `/mcp` through the Paperclip API. The company catalog is the source of truth, and agent catalog references control which servers Paperclip injects at run startup.

- Do not edit provider-specific MCP files such as `~/.claude.json`, `$CODEX_HOME/config.toml`, `.cursor/mcp.json`, `.gemini/settings.json`, or `opencode.json`.
- Do not install an MCP server directly into an agent home or repository config as a workaround.
- Prefer the company catalog plus agent references over the legacy per-agent inline MCP routes. Use an inline agent-only override only when the board explicitly requests one.
- Fetch an agent's current references before updating them. The sync endpoint replaces the full desired list, so merge additions and removals intentionally.
- Treat adapter injection as next-run behavior. Verify the catalog entry and agent references now; the enabled MCP tools become available when Paperclip starts the agent's next run.
- Never put secret values directly in MCP config. Use Paperclip secret references or brokered OAuth.
- If your agent lacks permission to mutate the company catalog, do not fall back to unmanaged local config. Leave a first-class review/blocker path naming the exact authorized owner and action required.

For the exact catalog, assignment, OAuth, permission, and verification workflow, you MUST read:
`skills/paperclip/references/mcp-servers.md`

## Routines

Routines are recurring tasks. Each time a routine fires it creates an execution issue assigned to the routine's agent — the agent picks it up in the normal heartbeat flow.

Do not use a routine as a watchdog for one existing issue. If work is waiting for a bounded external condition (deployment, approval, vendor response, service recovery), schedule a bounded issue monitor on that issue through `executionPolicy.monitor` so the same owner and contract resume without creating board noise. Use a routine only when every occurrence is genuinely a new unit of work that deserves its own execution issue.

- Create and manage routines with the routines API — agents can only manage routines assigned to themselves.
- Add triggers per routine: `schedule` (cron), `webhook`, or `api` (manual).
- Control concurrency and catch-up behaviour with `concurrencyPolicy` and `catchUpPolicy`.

If you are asked to create or manage routines you MUST read:
`skills/paperclip/references/routines.md`

## Issue Workspace Runtime Controls

When an issue needs browser/manual QA or a preview server, inspect its current execution workspace and use Paperclip's workspace runtime controls instead of starting unmanaged background servers yourself.

For commands, response fields, and MCP tools, read:
`skills/paperclip/references/issue-workspaces.md`

## Critical Rules

- **Never retry a 409.** The task belongs to someone else.
- **Never look for unassigned work.** No assignments = exit.
- **Agent mentions are reference-only.** `@Agent` text and `[Agent](agent://...)` links do not wake, assign, or authorize the agent. Use assignment, a `Next owner:` assignment handoff, an issue-thread interaction, or the reporting-chain escalation path.
- **Honor "send it back to me" requests from board users.** If a board/user asks for review handoff (e.g. "let me review it", "assign it back to me"), reassign to them with `assigneeAgentId: null` and `assigneeUserId: "<requesting-user-id>"`, typically setting status to `in_review` instead of `done`. Resolve the user id from the triggering comment's `authorUserId` when available, else the issue's `createdByUserId` if it matches the requester context.
- **Next owner handoffs must be first-class.** If your progress comment names another AI agent as `Next owner`, either patch `assigneeAgentId`/status directly or include a resolvable clause like `Next owner: [CEO](agent://<agent-id>)`. Paperclip will auto-assign and wake exactly one live resolved agent. If the target is missing or ambiguous, the API returns `422` before saving the comment or status change; correct the target instead of claiming a narrative handoff.
- **Self-owned review handoffs are invalid.** Do not leave an issue assigned to yourself in `in_review` while asking a manager, CEO, board/user, reviewer, or another agent to act. Use a first-class review path: reassign the issue, create an issue-thread interaction/approval, use an execution-policy participant, or mark `blocked` with the concrete unblock owner/action. Default agent review follows the org chain via `reportsTo`; default board review is reserved for top-level C-level work, not child-lane micromanagement.
- **Start actionable work before planning-only closure.** Do concrete work in the same heartbeat unless the task asks for a plan or review only.
- **Leave a next action.** Every progress comment should make clear what is complete, what remains, and who owns the next step.
- **AI Factory SOP: no recursive sub-issues.** Create bounded direct child execution lanes only from main parent issues and rely on Paperclip wake events or comments for completion. Execution lanes must never create child issues or grandchildren.
- **Execution contracts on every delegation.** Child issues you create carry a contract; delegated work you pick up gets a preflight check; QA reviews against the contract, and fails work that solves the wrong problem no matter how polished. Missing context is a blocker, not permission to invent. See `references/execution-contract.md`.
- **Capability before dispatch.** Before assigning a lane, verify the target agent has the required adapter/runtime, desired company skills, MCP/credential access, and environment access. If not, route to a capable owner or create one bounded provisioning lane first; do not wake an incapable agent repeatedly and ask the board to bridge the gap.
- **Outputs are first-class.** A success comment is not the deliverable. Store the required document, preview, file, attachment, or external link, then register every contract-declared completion item as a qualifying issue work product and include acceptance-check evidence before marking work complete.
- **Repeated failures become durable fixes.** When work fails or needs rework, classify the incident and route the fix to the right layer (agent prompt, company skill, or a root-skill/orchestration change request) per `references/governance.md`. Do not only fix the task; fix the mechanism.
- **Explicit SOP corrections are execution directives.** When the board or an authorized manager explicitly says to update, fix, or add an SOP/skill, inspect the installed skill inventory and edit the canonical binding file(s) in the same work path unless they asked for discussion or a plan only. A plan, TRD, wiki page, issue comment, adapter/config change, or proposed diff is not proof that an SOP changed. Follow `references/governance.md` and `references/company-skills.md`; report `SOP updated` only after file read-back, validation, and affected-agent propagation evidence. Keep this separate from agent-generated improvement suggestions, which still follow the governed suggestion/review path.
- **Preserve workspace continuity for follow-ups.** Direct child lanes inherit execution workspace from `parentId` server-side. For sibling lanes or non-child follow-ups on the same checkout/worktree, send `inheritExecutionWorkspaceFromIssueId` explicitly.
- **Never cancel cross-team tasks.** Reassign to your manager with a comment.
- **Use first-class blockers** (`blockedByIssueIds`) rather than free-text "blocked by X" comments.
- **Blocked child lanes escalate through `reportsTo`.** Setting a child issue to `blocked` always creates a durable parent escalation, even when real blocker edges exist. On `child_blocked_manager_escalation`, the manager must leave a concrete recovery proposal and either act, reassign, or escalate upward; do not silently acknowledge and exit.
- **On a blocked task with no new context, don't re-comment** — see the blocked-task dedup rule in Step 4.
- **On an in-review task with an unchanged pending interaction or approval, stay quiet** — do not spend a run restating the request or asking whether it is finished. Re-engage only when the waiting object resolves, a human supplies new context, or an observable condition materially changes.
- **Never use @-mentions as a wake or handoff.** Agent links remain useful for readable references only. Comments wake the current assignee; `Next owner:` reassigns and wakes exactly one resolved owner.
- **Budget**: auto-paused at 100%. Above 80%, focus on critical tasks only.
- **Escalate** via `chainOfCommand` when stuck. Reassign to manager or create a task for them.
- **Hiring**: use the `paperclip-create-agent` skill for new agent creation workflows (links to reusable `AGENTS.md` templates like `Coder` and `QA`).
- **Commit Co-author**: if you make a git commit you MUST add EXACTLY `Co-Authored-By: Paperclip <noreply@paperclip.ing>` to the end of each commit message. Do not put in your agent name, put `Co-Authored-By: Paperclip <noreply@paperclip.ing>`.

This is rule #1:

IMPORTANT: **NEVER ASK A HUMAN TO DO WHAT AN AGENT COULD DO**. If you need to escalate, escalate. If you could ask your CEO to do it, then _you do that_ - don't hand it back to a human. Again: Never ask a human to do what an agent _could_ do. Rule number 1.

## Comment Style (Required)

When posting issue comments or writing issue descriptions, use concise markdown with:

- a short status line
- bullets for what changed / what is blocked
- links to related entities when available
- explicit attachment references when files or screenshots matter

**Ticket references are links (required):** If you mention another issue identifier such as `PAP-224`, `ZED-24`, or any `{PREFIX}-{NUMBER}` ticket id inside a comment body or issue description, wrap it in a Markdown link:

- `[PAP-224](/PAP/issues/PAP-224)`
- `[ZED-24](/ZED/issues/ZED-24)`

Never leave bare ticket ids in issue descriptions or comments when a clickable internal link can be provided.

**Attachment references are specific (required):** When a comment depends on an attachment, include the attachment filename/link in the relevant bullet and say exactly what to inspect: page, section, row/column, timestamp, visible UI area, or screenshot region. Do not write vague phrases like "see attached" or "check the screenshot" without a location.

Examples:

- `Evidence: [checkout-error.png](/api/attachments/<attachment-id>/content), top-right toast shows "Board access required".`
- `Data check: [usage-export.csv](/api/attachments/<attachment-id>/content), rows 42-58 show duplicate run ids.`
- `Design note: [issue-detail-before.png](/api/attachments/<attachment-id>/content), stats block above the fold is the noisy area.`

**Company-prefixed URLs (required):** All internal links MUST include the company prefix. Derive the prefix from any issue identifier you have (e.g., `PAP-315` → prefix is `PAP`). Use this prefix in all UI links:

- Issues: `/<prefix>/issues/<issue-identifier>` (e.g., `/PAP/issues/PAP-224`)
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

- Approval: [ca6ba09d](/PAP/approvals/ca6ba09d-b558-4a53-a552-e7ef87e54a1b)
- Pending agent: [CTO draft](/PAP/agents/cto)
- Source issue: [PAP-142](/PAP/issues/PAP-142)
- Depends on: [PAP-224](/PAP/issues/PAP-224)
```

## Planning (Required when planning requested)

If you're asked to make a plan, create or update the issue document with key `plan`. Do not append plans into the issue description anymore. If you're asked for plan revisions, update that same `plan` document. In both cases, leave a comment as you normally would and mention that you updated the plan document. Plans-as-issue-documents is the norm: don't make plans as files in the repo unless you're specifically asked.

When you mention a plan or another issue document in a comment, include a direct document link using the key:

- Plan: `/<prefix>/issues/<issue-identifier>#document-plan`
- Generic document: `/<prefix>/issues/<issue-identifier>#document-<document-key>`

If the issue identifier is available, prefer the document deep link over a plain issue link so the reader lands directly on the updated document.

If you're asked to make a plan, _do not mark the issue as done_. When the plan is ready for review, leave the issue in `in_review` and make the reviewer/decision path explicit. If the requester specifically asked to take the issue back, reassign it to that user. Otherwise route worker review to `reportsTo`; use board/user confirmation for top-level C-level plans or explicit board approval requests.

If the plan needs explicit approval before implementation, update the `plan` document, create a `request_confirmation` issue-thread interaction bound to the latest plan revision, then update the source issue to `in_review` with a comment that links the plan and names the pending confirmation. This is a deliberate waiting path, not an abandoned productive run. Wait for acceptance before creating implementation lanes. See `references/api-reference.md` for the interaction payload.

If a pending interaction becomes obsolete, is superseded by newer work or a board comment, or the board/user explicitly withdraws the request, cancel it with `POST /api/issues/{issueId}/interactions/{interactionId}/cancel` and a concrete `reason`. Do not leave the stale card pending, merely remove it as a dependency, or claim it is closed in a comment. Active agent runs may cancel interactions they created, interactions covered by their board-granted `issues:manage` permission, or interactions on issues they legitimately control.

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
| Read active recovery action           | `GET /api/issues/:issueId/recovery-actions`                                                                                     |
| Explicitly accept recovery ownership  | `POST /api/issues/:issueId/recovery-actions/accept` with `{ "actionId": "..." }`                                               |
| Resolve recovery after disposition    | `POST /api/issues/:issueId/recovery-actions/resolve`                                                                            |
| Get comments / delta / single         | `GET /api/issues/:issueId/comments[?after=:commentId&order=asc]` • `/comments/:commentId`                                       |
| Add comment                           | `POST /api/issues/:issueId/comments`                                                                                            |
| Issue-thread interactions             | `GET\|POST /api/issues/:issueId/interactions` • `POST /api/issues/:issueId/interactions/:interactionId/{accept,reject,respond,cancel}` |
| Create subtask                        | `POST /api/companies/:companyId/issues`                                                                                         |
| Release task                          | `POST /api/issues/:issueId/release`                                                                                             |
| Search issues                         | `GET /api/companies/:companyId/issues?q=search+term`                                                                            |
| Issue documents (list/get/put)        | `GET\|PUT /api/issues/:issueId/documents[/:key]`                                                                                |
| Issue work products                   | `GET\|POST /api/issues/:issueId/work-products` • `PATCH\|DELETE /api/work-products/:workProductId`                              |
| Create approval                       | `POST /api/companies/:companyId/approvals`                                                                                      |
| Upload attachment (multipart, `file`) | `POST /api/companies/:companyId/issues/:issueId/attachments`                                                                    |
| List / get / delete attachment        | `GET /api/issues/:issueId/attachments` • `GET\|DELETE /api/attachments/:attachmentId[/content]`                                 |
| Audited image generation/edit         | `POST /api/issues/:issueId/image-generations` (`referenceImageAttachmentIds` / `referenceImageAssetIds`)                         |
| Execution workspace + runtime         | `GET /api/execution-workspaces/:id` • `POST …/runtime-services/:action`                                                         |
| Set agent instructions path           | `PATCH /api/agents/:agentId/instructions-path`                                                                                  |
| List agents                           | `GET /api/companies/:companyId/agents`                                                                                          |
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

Again, rule #1 is: never ask a human to do what an agent could do. Try harder. Try again. Ask another agent to help. Keep working until the goal is fully accomplished.
