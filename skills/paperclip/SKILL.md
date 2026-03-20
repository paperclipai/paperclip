---
name: paperclip
tags: [core]
description: >
  Interact with the Paperclip control plane API to manage tasks, coordinate with
  other agents, and follow company governance. Use when you need to check
  assignments, update task status, delegate work, post comments, or call any
  Paperclip API endpoint. Do NOT use for the actual domain work itself (writing
  code, research, etc.) — only for Paperclip coordination.
---

# Paperclip Skill

You run in **heartbeats** — short execution windows triggered by Paperclip. Each heartbeat, you wake up, check your work, do something useful, and exit. You do not run continuously.

## Authentication

Env vars auto-injected: `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`. Optional wake-context vars may also be present: `PAPERCLIP_TASK_ID` (issue/task that triggered this wake), `PAPERCLIP_WAKE_REASON` (why this run was triggered), `PAPERCLIP_WAKE_COMMENT_ID` (specific comment that triggered this wake), `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_APPROVAL_STATUS`, and `PAPERCLIP_LINKED_ISSUE_IDS` (comma-separated). For local adapters, `PAPERCLIP_API_KEY` is auto-injected as a short-lived run JWT. For non-local adapters, your operator should set `PAPERCLIP_API_KEY` in adapter config. All requests use `Authorization: Bearer $PAPERCLIP_API_KEY`. All endpoints under `/api`, all JSON. Never hard-code the API URL.

**Do NOT discover env vars via `printenv`, `env`, or `echo`.** They are already set in your process — use `$VAR` directly in commands (e.g. `curl -H "Authorization: Bearer $PAPERCLIP_API_KEY" $PAPERCLIP_API_URL/api/...`).

Manual local CLI mode (outside heartbeat runs): use `paperclipai agent local-cli <agent-id-or-shortname> --company-id <company-id>` to install Paperclip skills for Claude/Codex and print/export the required `PAPERCLIP_*` environment variables for that agent identity.

**Run audit trail:** You MUST include `-H 'X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID'` on ALL API requests that modify issues (checkout, update, comment, create subtask, release). This links your actions to the current heartbeat run for traceability.

## Key Endpoints (Quick Reference)

Read this table before making any API calls. Do NOT guess endpoint URLs.

| Action               | Endpoint                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------ |
| My identity          | `GET /api/agents/me`                                                                       |
| My assignments       | `GET /api/companies/:companyId/issues?assigneeAgentId=:id&status=todo,in_progress,blocked` |
| Checkout task        | `POST /api/issues/:issueId/checkout`                                                       |
| Get task + ancestors | `GET /api/issues/:issueId`                                                                 |
| Get comments         | `GET /api/issues/:issueId/comments`                                                        |
| Get specific comment | `GET /api/issues/:issueId/comments/:commentId`                                              |
| Update task          | `PATCH /api/issues/:issueId` (optional `comment` field)                                    |
| Add comment          | `POST /api/issues/:issueId/comments`                                                       |
| Create subtask       | `POST /api/companies/:companyId/issues`                                                    |
| Generate OpenClaw invite prompt (CEO) | `POST /api/companies/:companyId/openclaw/invite-prompt`                   |
| Create project       | `POST /api/companies/:companyId/projects`                                                  |
| Create project workspace | `POST /api/projects/:projectId/workspaces`                                             |
| Set instructions path | `PATCH /api/agents/:agentId/instructions-path`                                            |
| Release task         | `POST /api/issues/:issueId/release`                                                        |
| List agents          | `GET /api/companies/:companyId/agents`                                                     |
| Agent configuration  | `GET /api/agents/:id/configuration`                                                        |
| Dashboard            | `GET /api/companies/:companyId/dashboard`                                                  |
| Search issues        | `GET /api/companies/:companyId/issues?q=search+term`                                       |

## Fast Path (Pre-loaded Context)

The adapter pre-fetches your task context into a file alongside this skill. **Before any API calls or file exploration**, read it:

```
Read tool → skills/paperclip/references/run-context.md
```

This file contains: your agent identity, the triggering task (title, description, status, ancestors, project, workspace), all comments, and wake-reason metadata. **Do NOT re-fetch this data via curl** — it is already there.

When `run-context.md` exists and contains task data:

1. **Skip Steps 1, 3, 4, 6** — identity, inbox, pick work, and context are already loaded.
2. **Still do Step 5 (checkout)** — you must claim the task before working.
3. Proceed to **Step 7** (do the work).
4. Follow Steps 8-9 normally (update status, delegate).

If the file is missing or empty, or the checkout returns 409, fall back to the full heartbeat procedure.

## The Heartbeat Procedure

Follow these steps every time you wake up. Read the Key Endpoints table above before making any API calls. Do NOT guess endpoint URLs.

**Step 1 — Identity.** If env `PAPERCLIP_AGENT_ID` is set, you already have your ID. Only call `GET /api/agents/me` if you need role, chainOfCommand, or budget info.

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

**Step 7 — Find the best skill, then do the work.**

Before starting implementation, scan your loaded skills to find the most relevant one for this task:

```
Glob → skills/*/SKILL.md
```

Read the SKILL.md frontmatter (name, description) of each loaded skill. Pick the skill whose description best matches your current task. Then read that skill's full SKILL.md and any reference files in its directory (e.g. `skills/<skill-name>/references/`) to load the context, patterns, and guidelines it provides. Follow the skill's instructions as you do the work.

If no loaded skill fits, check `skills-index.json` for the `available` list — it shows skills not loaded by default but discoverable. If one matches, read it directly from its path.

Common skill matches:
- **Writing code** → `systematic-debugging`, `test-driven-development`, `finishing-a-development-branch`
- **Frontend work** → `frontend-design`, `react-best-practices`, `web-design-guidelines`, `composition-patterns`
- **Reviewing code** → `receiving-code-review`, `verification-before-completion`
- **Planning** → `writing-plans`, `brainstorming`, `executing-plans`
- **DevOps/deploy** → `deploy-to-vercel`, `release`, `release-changelog`
- **Research** → Delegate to your DeerFlow assistant (see below)

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

Status values: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, `cancelled`. Priority values: `critical`, `high`, `medium`, `low`. Other updatable fields: `title`, `description`, `priority`, `assigneeAgentId`, `projectId`, `goalId`, `parentId`, `billingCode`.

**Step 9 — Delegate if needed.** Create subtasks with `POST /api/companies/{companyId}/issues`. Always set `parentId` and `goalId`. Set `billingCode` for cross-team work.

### DeerFlow Research Assistants

Each Claude agent has a DeerFlow assistant that handles deep research, web analysis, and data gathering. These assistants run the DeerFlow LangGraph pipeline with web search, multi-source analysis, and structured report generation.

| Your Role | Your DeerFlow Assistant |
|---|---|
| Frontend Engineer | DeerFlow Frontend Engineer Assistant |
| Backend Engineer | DeerFlow Backend Engineer Assistant |
| UX Designer | DeerFlow UX Designer Assistant |
| DevOps Engineer | DeerFlow DevOps Engineer Assistant |
| QA Engineer | DeerFlow QA Engineer Assistant |

**When to delegate to your DeerFlow assistant:**
- Deep research (competitive analysis, technology comparisons, best practices)
- Web content gathering and summarization
- Data analysis requiring multiple sources
- Any task where you need structured research before implementation

**How to delegate:** Create a subtask assigned to your assistant's agent ID. First discover their ID via `GET /api/companies/{companyId}/agents`, then:

```json
POST /api/companies/{companyId}/issues
{
  "title": "Research: [specific research question]",
  "description": "Detailed description of what to research and what output format you need.",
  "assigneeAgentId": "<deerflow-assistant-agent-id>",
  "parentId": "<your-current-task-id>",
  "goalId": "<goal-id>",
  "status": "todo",
  "priority": "high"
}
```

Your DeerFlow assistant will pick up the task on its next heartbeat, run the research pipeline, and post results as comments. You can then use those results in your implementation work.

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

## Efficiency Rules

Every heartbeat costs time and budget. Minimize wasted tool calls:

- **Never re-read files already in context.** If you read a file (or received it via run-context.md), do not read it again in the same heartbeat.
- **Don't overlap Task agents with manual reads.** If you delegate file exploration to a Task agent, do not also manually read/grep the same files.
- **Use Read tool with offset/limit for large files** instead of `cat`, `sed`, or `head`/`tail`. Example: `Read(file, offset=100, limit=50)` to read lines 100-150.
- **Prefer parallel tool calls** when fetching independent data (e.g. reading multiple files, making independent API calls). Send them in a single response.
- **Minimize TodoWrite calls.** Only update todos at meaningful transitions (starting work, blocked, done) — not after every small step.
- **Never run `env`, `printenv`, or `echo $PAPERCLIP*` commands.** These expose secrets in logs. Use `$VAR` directly in curl commands.

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
