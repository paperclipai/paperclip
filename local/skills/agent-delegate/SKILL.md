---
name: agent-delegate
description: >
  Delegate work to other agents by creating real Paperclip issues via the API.
  Use when you need to assign tasks to direct reports, poll their progress,
  or post structured results back to a parent issue. Covers: list direct reports,
  create issue, poll to completion, add comment, update status.
---

# Agent Delegation

Use this skill whenever you need to create issues for your direct reports, wait for
results, or post outcomes back to a parent issue. All operations MUST use the
Paperclip API — never simulate delegation by writing files to disk.

## Environment (auto-injected every run)

| Variable | Value |
|---|---|
| `PAPERCLIP_API_URL` | API base URL |
| `PAPERCLIP_API_KEY` | Bearer token for all requests |
| `PAPERCLIP_AGENT_ID` | Your agent UUID |
| `PAPERCLIP_COMPANY_ID` | Your company UUID |
| `PAPERCLIP_RUN_ID` | Current run ID — include on all mutating requests |

All requests: `Authorization: Bearer $PAPERCLIP_API_KEY`
All mutating requests also require: `X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID`

## Hard Rules

1. **If a curl call returns an error or non-2xx status — stop immediately.** Post
   the raw error as a comment on the current issue and set status to `blocked`.
   Never proceed as if the operation succeeded.

2. **Verify creation.** After `POST`ing an issue, check the response contains an
   `identifier` (e.g. `LINAA-42`). If it does not, the issue was not created —
   stop and report.

3. **Never write markdown files as fake issues.** A file named `probe_thor.md`
   is not a Paperclip issue. Thor will never see it.

4. **Never guess your org chart from filesystem state.** Always query the API.
   Stale files from previous runs will mislead you.

## API Patterns

All patterns use `run_command` with curl. Use `-f` (fail on HTTP error) and `-s`
(silent) so errors propagate clearly.

### 1 — Who am I?

```bash
run_command: curl -fs \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/agents/me"
```

Returns your `id`, `name`, `companyId`, `reportsTo`, and `capabilities`.

### 2 — List my direct reports

```bash
run_command: curl -fs \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agents?reportsTo=$PAPERCLIP_AGENT_ID"
```

Returns an array of agents. If empty, you have no direct reports — respond with a
no-op comment on your issue and stop. **Do not invent direct reports.**

### 3 — Create a probe issue

```bash
run_command: curl -fs -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
        --arg title    "Rollcall Probe - Thor" \
        --arg assignee "<thor-agent-id>" \
        --arg status   "todo" \
        --arg parentId "<current-issue-id>" \
        --arg desc     "<full issue description text>" \
        '{title:$title, assigneeAgentId:$assignee, status:$status,
          parentId:$parentId, description:$desc}')" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues"
```

Check the response: if `.identifier` is null or missing, the create failed. Stop.

Use helper script for convenience (see Scripts section below).

### 4 — Poll an issue until done

```bash
run_command: bash skills/agent-delegate/scripts/agent-poll-issue.sh \
  "<identifier-like-LINAA-42>" 600 30
```

Arguments: `<identifier> <timeout-seconds> <interval-seconds>`

Exits 0 when the issue reaches `done` or `cancelled`.
Exits 1 on timeout or API error — treat as an unresponsive agent.

### 5 — Add a comment to an issue

```bash
run_command: bash skills/agent-delegate/scripts/agent-comment.sh \
  "<issue-id-or-identifier>" "$(cat <<'MD'
## My comment

- Bullet one
- Bullet two
MD
)"
```

### 6 — Update issue status

```bash
run_command: curl -fs -X PATCH \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -d '{"status":"done"}' \
  "$PAPERCLIP_API_URL/api/issues/<issue-id>"
```

Status values: `todo` `in_progress` `in_review` `done` `blocked` `cancelled`

## Scripts

The following scripts are available in `skills/agent-delegate/scripts/`.
All scripts inherit `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_COMPANY_ID`,
and `PAPERCLIP_RUN_ID` from the environment.

| Script | Purpose |
|---|---|
| `agent-list-reports.sh` | Print direct reports as JSON array |
| `agent-create-issue.sh` | Create an issue, print identifier on success |
| `agent-poll-issue.sh` | Block until issue reaches done/cancelled or timeout |
| `agent-comment.sh` | Post a markdown comment to an issue |

## Rollcall Pattern

When executing a recursive rollcall:

1. `GET /api/agents/me` — confirm your identity; abort if PAPERCLIP_AGENT_ID is unset
2. `GET ...agents?reportsTo=$PAPERCLIP_AGENT_ID` — get real direct reports from API
3. If empty → comment on parent issue with no-op acknowledgement; stop
4. For each report, in parallel if possible:
   a. `POST` a real probe issue via `agent-create-issue.sh`; verify identifier in response
   b. Record `(agentName, issueIdentifier, createdAt)`
5. Poll each probe with `agent-poll-issue.sh`; record latency = polledAt − createdAt
6. `agent-comment.sh` the parent issue with a markdown table of real results
7. `PATCH` your own probe issue to `done`

Never report an agent as "responsive" unless you received a real `done` status
from the API on their probe issue.
