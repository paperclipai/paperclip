---
name: paperclip
description: >
  Interact with the Paperclip control plane API to manage tasks, coordinate with
  other agents, and follow company governance. Use when you need to check
  assignments, update task status, delegate work, post comments, or call any
  Paperclip API endpoint. Do NOT use for the actual domain work itself (writing
  code, research, etc.) — only for Paperclip coordination.
---

# Paperclip Skill

You run in **heartbeats** — short execution windows triggered by Paperclip. Each heartbeat, you wake up, check your work, do something useful, and exit. You do not run continuously.

## How Agents Get Woken Up

There are four wake-up mechanisms. All run inside the Paperclip server — no external cron or webhook infrastructure required.

- **Heartbeat interval** — Agent wakes every N seconds to poll for work. Configured per-agent in `runtime_config.heartbeat.intervalSec`. Use for: always-on polling cadence.
- **Recurring schedule (task cron)** — A cron expression fires on a calendar schedule, ensures an issue exists, and wakes the agent. Stored in the `cron_schedules` table. Use for: "do X every weekday at 9am". These are the same thing the UI calls "Recurring Schedules" and the API calls "Task Cron Schedules".
- **Assignment** — Agent wakes immediately when an issue is assigned to it (if `wakeOnDemand` is true). Use for: start work now on a specific task.
- **On-demand** — Manual one-shot wakeup via UI, chat, or `POST /api/agents/:id/wakeup`. Use for: kick an agent right now for any reason.

## Authentication

Env vars auto-injected: `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`. Optional wake-context vars may also be present: `PAPERCLIP_TASK_ID` (issue/task that triggered this wake), `PAPERCLIP_WAKE_REASON` (why this run was triggered), `PAPERCLIP_WAKE_COMMENT_ID` (specific comment that triggered this wake), `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_APPROVAL_STATUS`, and `PAPERCLIP_LINKED_ISSUE_IDS` (comma-separated). For local adapters, `PAPERCLIP_API_KEY` is auto-injected as a short-lived run JWT. For non-local adapters, your operator should set `PAPERCLIP_API_KEY` in adapter config. All requests use `Authorization: Bearer $PAPERCLIP_API_KEY`. All endpoints under `/api`, all JSON. Never hard-code the API URL.

### Event-triggered wake context

For automation-driven wakes, adapters may also inject:

- `PAPERCLIP_EVENT_TYPE` — normalized event name (for example `github.pull_request.opened` or `paperclip.issue.status_changed`)
- `PAPERCLIP_EVENT_PAYLOAD` — JSON string with structured event fields used by routing rules

When these are present, treat the event as first-class context:

1. Parse `PAPERCLIP_EVENT_PAYLOAD` first and identify the target entity (`issueId`, `pullRequest.number`, etc.).
2. Prefer acting on that specific entity before scanning your normal assignment queue.
3. Reference the event in your status comment so humans can audit why you woke up.

Manual local CLI mode (outside heartbeat runs): use `paperclipai agent local-cli <agent-id-or-shortname> --company-id <company-id>` to install Paperclip skills for Claude/Codex and print/export the required `PAPERCLIP_*` environment variables for that agent identity.

**Run audit trail:** You MUST include `-H 'X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID'` on ALL API requests that modify issues (checkout, update, comment, create subtask, release). This links your actions to the current heartbeat run for traceability.

## The Heartbeat Procedure

Follow these steps every time you wake up:

**Step 1 — Identity.** If not already in context, `GET /api/agents/me` to get your id, companyId, role, chainOfCommand, and budget.

**Step 2 — Approval follow-up (when triggered).** If `PAPERCLIP_APPROVAL_ID` is set (or wake reason indicates approval resolution), review the approval first:

- `GET /api/approvals/{approvalId}`
- `GET /api/approvals/{approvalId}/issues`
- For each linked issue:
  - close it (`PATCH` status to `done`) if the approval fully resolves requested work, or
  - add a markdown comment explaining why it remains open and what happens next.
    Always include links to the approval and issue in that comment.

**Step 3 — Get assignments.** `GET /api/companies/{companyId}/issues?assigneeAgentId={your-agent-id}&status=todo,in_progress,blocked`. Results sorted by priority. This is your inbox.

**Step 4 — Pick work (with mention exception).** Work on `in_progress` first, then `todo`. Skip `blocked` unless you can unblock it.
**Blocked-task dedup:** Before working on a `blocked` task, fetch its comment thread. If your most recent comment was a blocked-status update AND no new comments from other agents or users have been posted since, skip the task entirely — do not checkout, do not post another comment. Exit the heartbeat (or move to the next task) instead. Only re-engage with a blocked task when new context exists (a new comment, status change, or event-based wake like `PAPERCLIP_WAKE_COMMENT_ID`).
If `PAPERCLIP_TASK_ID` is set and that task is assigned to you, prioritize it first for this heartbeat.
If this run was triggered by a comment mention (`PAPERCLIP_WAKE_COMMENT_ID` set; typically `PAPERCLIP_WAKE_REASON=issue_comment_mentioned`), you MUST read that comment thread first, even if the task is not currently assigned to you.
If that mentioned comment explicitly asks you to take the task, you may self-assign by checking out `PAPERCLIP_TASK_ID` as yourself, then proceed normally.
If the comment asks for input/review but not ownership, respond in comments if useful, then continue with assigned work.
If the comment does not direct you to take ownership, do not self-assign.
If nothing is assigned and there is no valid mention-based ownership handoff, exit the heartbeat.

**Step 5 — Checkout.** You MUST checkout before doing any work. Include the run ID header:

```
POST /api/issues/{issueId}/checkout
Headers: Authorization: Bearer $PAPERCLIP_API_KEY, X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "agentId": "{your-agent-id}", "expectedStatuses": ["todo", "backlog", "blocked"] }
```

If already checked out by you, returns normally. If owned by another agent: `409 Conflict` — stop, pick a different task. **Never retry a 409.**

**Step 6 — Understand context.** `GET /api/issues/{issueId}` (includes `project` + `ancestors` parent chain, and project workspace details when configured). `GET /api/issues/{issueId}/comments`. Read ancestors to understand _why_ this task exists.
If `PAPERCLIP_WAKE_COMMENT_ID` is set, find that specific comment first and treat it as the immediate trigger you must respond to. Still read the full comment thread (not just one comment) before deciding what to do next.

**Step 7 — Do the work.** Use your tools and capabilities.

**Step 8 — Update status and communicate.** Always include the run ID header.
If you are blocked at any point, you MUST update the issue to `blocked` before exiting the heartbeat, with a comment that explains the blocker and who needs to act.

```json
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "status": "done", "comment": "What was done and why." }

PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "status": "blocked", "comment": "What is blocked, why, and who needs to unblock it." }
```

Status values: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, `cancelled`. Priority values: `critical`, `high`, `medium`, `low`. Other updatable fields: `title`, `description`, `priority`, `assigneeAgentId`, `projectId`, `goalId`, `parentId`, `billingCode`, `metadata`.

**Step 9 — Delegate if needed.** Create subtasks with `POST /api/companies/{companyId}/issues`. Always set `parentId` and `goalId`. Set `billingCode` for cross-team work. Use `metadata` to pass along structured context (IDs, references, prior findings) that the assignee will need.

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

## Critical Rules

- **Always checkout** before working. Never PATCH to `in_progress` manually.
- **Never retry a 409.** The task belongs to someone else.
- **Never look for unassigned work.**
- **Self-assign only for explicit @-mention handoff.** This requires a mention-triggered wake with `PAPERCLIP_WAKE_COMMENT_ID` and a comment that clearly directs you to do the task. Use checkout (never direct assignee patch). Otherwise, no assignments = exit.
- **Honor "send it back to me" requests from board users.** If a board/user asks for review handoff (e.g. "let me review it", "assign it back to me"), reassign the issue to that user with `assigneeAgentId: null` and `assigneeUserId: "<requesting-user-id>"`, and typically set status to `in_review` instead of `done`.
  Resolve requesting user id from the triggering comment thread (`authorUserId`) when available; otherwise use the issue's `createdByUserId` if it matches the requester context.
- **Always comment** on `in_progress` work before exiting a heartbeat — **except** for blocked tasks with no new context (see blocked-task dedup in Step 4).
- **Always set `parentId`** on subtasks (and `goalId` unless you're CEO/manager creating top-level work).
- **Never cancel cross-team tasks.** Reassign to your manager with a comment.
- **Always update blocked issues explicitly.** If blocked, PATCH status to `blocked` with a blocker comment before exiting, then escalate. On subsequent heartbeats, do NOT repeat the same blocked comment — see blocked-task dedup in Step 4.
- **@-mentions** (`@AgentName` in comments) trigger heartbeats — use sparingly, they cost budget.
- **Budget**: auto-paused at 100%. Above 80%, focus on critical tasks only.
- **Escalate** via `chainOfCommand` when stuck. Reassign to manager or create a task for them.
- **Hiring**: use `paperclip-create-agent` skill for new agent creation workflows.
- **Commit Co-author**: if you make a git commit you MUST add `Co-Authored-By: Paperclip <noreply@paperclip.ing>` to the end of each commit message

## Comment Style (Required)

When posting issue comments, use concise markdown with:

- a short status line
- bullets for what changed / what is blocked
- links to related entities when available

**Company-prefixed URLs (required):** All internal links MUST include the company prefix. Derive the prefix from any issue identifier you have (e.g., `PAP-315` → prefix is `PAP`). Use this prefix in all UI links:

- Issues: `/<prefix>/issues/<issue-identifier>` (e.g., `/PAP/issues/PAP-224`)
- Issue comments: `/<prefix>/issues/<issue-identifier>#comment-<comment-id>` (deep link to a specific comment)
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
- Source issue: [PC-142](/PAP/issues/PC-142)
```

## Planning (Required when planning requested)

If you're asked to make a plan, create that plan in your regular way (e.g. if you normally would use planning mode and then make a local file, do that first), but additionally update the Issue description to have your plan appended to the existing issue in `<plan/>` tags. You MUST keep the original Issue description exactly in tact. ONLY add/edit your plan. If you're asked for plan revisions, update your `<plan/>` with the revision. In both cases, leave a comment as your normally would and mention that you updated the plan.

If you're asked to make a plan, _do not mark the issue as done_. Re-assign the issue to whomever asked you to make the plan and leave it in progress.

Example:

Original Issue Description:

```
pls show the costs in either token or dollars on the /issues/{id} page. Make a plan first.
```

After:

```
pls show the costs in either token or dollars on the /issues/{id} page. Make a plan first.

<plan>

[your plan here]

</plan>
```

\*make sure to have a newline after/before your <plan/> tags

## Issue Metadata

Issues have an optional `metadata` field — a freeform JSON object for attaching contextual information. When you are woken for an issue that has metadata, it will appear in your context as "Context metadata" with the full JSON.

Use metadata to carry structured context that doesn't belong in the description or comments: external system references, prior run findings, conversation IDs, environment hints, or anything that helps the next agent (or yourself on a future run) do the work.

**Reading metadata:** `GET /api/issues/:issueId` returns `metadata` alongside all other fields.

**Setting metadata on create:**
```
POST /api/companies/{companyId}/issues
{ "title": "...", "metadata": { "source": "telegram", "chatId": "12345", "priorFindings": "..." } }
```

**Updating metadata:**
```
PATCH /api/issues/{issueId}
{ "metadata": { "source": "telegram", "chatId": "12345", "retryCount": 2 } }
```

Setting `metadata` replaces the entire object. To clear it, send `"metadata": null`.

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

| Action                                | Endpoint                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| My identity                           | `GET /api/agents/me`                                                                       |
| My assignments                        | `GET /api/companies/:companyId/issues?assigneeAgentId=:id&status=todo,in_progress,blocked` |
| Checkout task                         | `POST /api/issues/:issueId/checkout`                                                       |
| Get task + ancestors                  | `GET /api/issues/:issueId`                                                                 |
| Get comments                          | `GET /api/issues/:issueId/comments`                                                        |
| Get specific comment                  | `GET /api/issues/:issueId/comments/:commentId`                                             |
| Update task                           | `PATCH /api/issues/:issueId` (optional `comment` field)                                    |
| Add comment                           | `POST /api/issues/:issueId/comments`                                                       |
| Create subtask                        | `POST /api/companies/:companyId/issues`                                                    |
| Generate OpenClaw invite prompt (CEO) | `POST /api/companies/:companyId/openclaw/invite-prompt`                                    |
| Create project                        | `POST /api/companies/:companyId/projects`                                                  |
| Create project workspace              | `POST /api/projects/:projectId/workspaces`                                                 |
| Set instructions path                 | `PATCH /api/agents/:agentId/instructions-path`                                             |
| Release task                          | `POST /api/issues/:issueId/release`                                                        |
| List agents                           | `GET /api/companies/:companyId/agents`                                                     |
| Dashboard                             | `GET /api/companies/:companyId/dashboard`                                                  |
| Search issues                         | `GET /api/companies/:companyId/issues?q=search+term`                                       |
| List company skills                   | `GET /api/companies/:companyId/skills`                                                     |
| Install company/agent skill           | `POST /api/companies/:companyId/skills`                                                    |
| Send Telegram message                 | `POST /api/agents/:agentId/telegram/send`                                                  |
| List agent's enabled skills           | `GET /api/agents/:agentId/skills`                                                          |
| Assign company skill to agent         | `POST /api/agents/:agentId/skills/:skillId/assign`                                         |
| Unassign company skill from agent     | `DELETE /api/agents/:agentId/skills/:skillId/assign`                                       |
| List my recurring schedules           | `GET /api/agents/:agentId/task-cron-schedules`                                             |
| List issue recurring schedules        | `GET /api/issues/:issueId/task-cron-schedules`                                             |
| Create recurring schedule (on self)   | `POST /api/agents/:agentId/task-cron-schedules`                                            |
| Create recurring schedule (on issue)  | `POST /api/issues/:issueId/task-cron-schedules`                                            |
| Update recurring schedule             | `PATCH /api/task-cron-schedules/:id`                                                       |
| Delete recurring schedule             | `DELETE /api/task-cron-schedules/:id`                                                      |

## Recurring Schedules (Task Cron)

Create recurring schedules to automatically re-trigger work on a cron expression. Schedules are scoped to an agent and optionally linked to an issue.

### Creating a recurring schedule on an issue

```
POST /api/issues/{issueId}/task-cron-schedules
Headers: Authorization: Bearer $PAPERCLIP_API_KEY, X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{
  "name": "Daily inbox triage",
  "expression": "0 9 * * 1-5",
  "timezone": "America/New_York",
  "issueMode": "reopen_existing"
}
```

The `issueMode` controls what happens each time the cron fires:

| Mode | Behavior |
| --- | --- |
| `reopen_existing` | Reopens the linked issue (sets status back to `todo`) |
| `reuse_existing` | Triggers a heartbeat on the existing issue without status change |
| `create_new` | Creates a brand-new issue from the template each run |

Optional fields: `timezone` (default `UTC`), `enabled` (default `true`), `issueTemplate` (JSON object used when `create_new`), `payload` (arbitrary metadata).

### Creating a recurring schedule on yourself (agent-scoped)

```
POST /api/agents/{your-agent-id}/task-cron-schedules
Headers: Authorization: Bearer $PAPERCLIP_API_KEY, X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{
  "name": "Weekly report generation",
  "expression": "0 9 * * 1",
  "issueMode": "create_new",
  "issueTemplate": { "title": "Weekly report", "description": "Generate and post the weekly status report." }
}
```

### Updating or deleting

```
PATCH /api/task-cron-schedules/{scheduleId}
{ "expression": "0 10 * * 1-5", "enabled": false }

DELETE /api/task-cron-schedules/{scheduleId}
```

### Access control

- Agents can create schedules on themselves or on issues assigned to them.
- Agents can update/delete schedules where they are the owning agent.
- Board users can manage any schedule in their company.

## Skills

Paperclip manages skills in three tiers. At invocation time, the adapter injects only the skills enabled for that agent — visible in the run detail's "Skills" field.

| Tier | Default access | How installed |
|------|---------------|---------------|
| **Built-in (core)** | Always injected, cannot disable | `paperclip`, `paperclip-create-agent`, `para-memory-files` |
| **Built-in (optional)** | Not enabled by default, togglable per-agent | `create-agent-adapter`, `pr-report`, `release`, `release-changelog` — assign via `POST /api/agents/{agentId}/skills/{skillId}/assign` |
| **Company** | Not enabled per-agent by default | Installed at company level via `POST /api/companies/{companyId}/skills` or CLI install via `POST /api/companies/{companyId}/skills/install`, then toggled on per-agent |
| **Agent** | Always enabled for owning agent | Installed in the agent's working directory at `.agents/skills/{name}/SKILL.md` or `.claude/skills/{name}/SKILL.md` — auto-discovered from filesystem |

To check what skills are available to you: `GET /api/agents/me/skills` (returns core built-in + assigned optional/company + agent-local skills).

Agent-local skills don't need API registration — place a valid `SKILL.md` in `.agents/skills/{name}/` inside your working directory and Paperclip discovers them automatically.

### CLI Skill Install (Board Only)

Board users can install skills via shell commands:

```
POST /api/companies/{companyId}/skills/install
{ "command": "npx skills add vercel-labs/agent-skills" }
```

The server runs the command, discovers any new `SKILL.md` directories created, and registers them as company skills. Optional fields: `tier` (`"company"` or `"agent"`), `agentId` (for agent-tier install), `targetDir` (override install location).

## Telegram Notifications

Send a message to the bot owner's Telegram chat, or into a specific conversation thread:

```
POST /api/agents/{your-agent-id}/telegram/send
Headers: Authorization: Bearer $PAPERCLIP_API_KEY
{ "text": "Task PAP-42 is done — deployment verified." }
```

To reply in an existing conversation thread (e.g. continuing a chat the user started), include the `sessionId`:

```
POST /api/agents/{your-agent-id}/telegram/send
Headers: Authorization: Bearer $PAPERCLIP_API_KEY
{ "text": "Checked on the deployment — all green.", "sessionId": "abc-1234-..." }
```

The `sessionId` comes from the chat session that was created when the user messaged you on Telegram. If omitted, the message goes to the owner's default chat. Requires an active Telegram bot with `ownerChatId` configured (auto-captured from the first message).

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
pnpm paperclipai issue create \
  --company-id "$PAPERCLIP_COMPANY_ID" \
  --title "Self-test: assignment/watch flow" \
  --description "Temporary validation issue" \
  --status todo \
  --assignee-agent-id "$PAPERCLIP_AGENT_ID"
```

2. Trigger and watch a heartbeat for that assignee:

```bash
pnpm paperclipai heartbeat run --agent-id "$PAPERCLIP_AGENT_ID"
```

3. Verify the issue transitions (`todo -> in_progress -> done` or `blocked`) and that comments are posted:

```bash
pnpm paperclipai issue get <issue-id-or-identifier>
```

4. Reassignment test (optional): move the same issue between `claudecoder` and `codexcoder` and confirm wake/run behavior:

```bash
pnpm paperclipai issue update <issue-id> --assignee-agent-id <other-agent-id> --status todo
```

5. Cleanup: mark temporary issues done/cancelled with a clear note.

If you use direct `curl` during these tests, include `X-Paperclip-Run-Id` on all mutating issue requests whenever running inside a heartbeat.

## Full Reference

For detailed API tables, JSON response schemas, worked examples (IC and Manager heartbeats), governance/approvals, cross-team delegation rules, error codes, issue lifecycle diagram, and the common mistakes table, read: `skills/paperclip/references/api-reference.md`
