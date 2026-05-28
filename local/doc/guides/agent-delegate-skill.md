---
title: agent-delegate Skill
summary: Delegating work to other agents via the Paperclip API
---

The `agent-delegate` skill gives agents the primitives to create real Paperclip issues for their direct reports, poll for completion, and post results back to a parent issue. It is the foundation for any agent that coordinates work across an org chart.

For the strict rollcall protocol specifically, see the `agent-rollcall` skill.

## When to use this skill

Assign `agent-delegate` to any agent that:
- Creates child issues and assigns them to direct reports
- Needs to poll a subordinate's issue until it completes
- Posts structured results back to a parent issue as a comment
- Updates issue status as part of a workflow handoff

## Hard Rules

These are not guidelines — violating them means the delegation did not happen:

1. **A file on disk is not a Paperclip issue.** Writing `.md` files to the workspace and treating them as delegated tasks is a fabrication. Direct reports will never see them.
2. **If a curl call fails, stop immediately.** Post the raw error as a comment on your current issue and set status to `blocked`. Never proceed as if the operation succeeded.
3. **Verify creation.** After `POST`ing an issue, confirm the response contains an `identifier` (e.g. `LINAA-42`). If it does not, the issue was not created — stop and report.
4. **Never guess your org chart from filesystem state.** Stale files from previous runs will mislead you. Always query the API.
5. **Never report an agent as responsive** unless you received a real `done` status from the API on their probe issue.

## Helper Scripts

The skill ships with four scripts in `skills/agent-delegate/scripts/`. All inherit `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_COMPANY_ID`, and `PAPERCLIP_RUN_ID` from the environment.

### `agent-list-reports.sh`

Prints direct reports of the current agent as a JSON array.

```bash
bash skills/agent-delegate/scripts/agent-list-reports.sh
# Optional: pass a different agent ID as $1
```

Returns an empty array `[]` if the agent has no direct reports. If the response is not valid JSON, exits 1.

### `agent-create-issue.sh`

Creates an issue and prints its identifier (e.g. `LINAA-42`) on stdout. Exits 1 if the identifier is missing from the response.

```bash
bash skills/agent-delegate/scripts/agent-create-issue.sh \
  --title "Do the thing" \
  --assignee "<agent-uuid>" \
  --description "Full task description" \
  --parent "<parent-issue-uuid>" \   # optional
  --project "<project-uuid>"         # optional
```

### `agent-poll-issue.sh`

Blocks until an issue reaches `done` or `cancelled`, then prints `status=`, `elapsed=`, and `identifier=` on stdout. Exits 0 on terminal status, 1 on timeout or API error.

```bash
bash skills/agent-delegate/scripts/agent-poll-issue.sh \
  "<identifier-or-uuid>" \
  600 \   # timeout seconds (default: 600)
  30      # poll interval seconds (default: 30)
```

Treat a non-zero exit as an unresponsive agent — set the parent issue to `blocked` and name the stalled identifier.

### `agent-comment.sh`

Posts a markdown comment to an issue. Accepts an identifier (`LINAA-42`) or UUID. Uses `jq` for safe encoding — newlines and special characters in the body are preserved correctly.

```bash
bash skills/agent-delegate/scripts/agent-comment.sh \
  "<issue-id-or-identifier>" "$(cat <<'MD'
## Result

- Thing one done
- Thing two done
MD
)"
```

## API Patterns

Use these when you need more control than the scripts provide.

### Who am I?

```bash
curl -fs \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/agents/me"
```

Returns `id`, `name`, `companyId`, `reportsTo`, and `capabilities`.

### List direct reports

```bash
curl -fs \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agents?reportsTo=$PAPERCLIP_AGENT_ID"
```

If the array is empty, you have no direct reports. Do not invent them.

### Create an issue

```bash
curl -fs -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
        --arg title    "Task title" \
        --arg assignee "<agent-uuid>" \
        --arg parentId "<parent-issue-uuid>" \
        --arg desc     "Full description" \
        '{title:$title, assigneeAgentId:$assignee,
          status:"todo", parentId:$parentId, description:$desc}')" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues"
```

Always include `X-Paperclip-Run-Id` on mutating requests.

### Update issue status

```bash
curl -fs -X PATCH \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -d '{"status":"done"}' \
  "$PAPERCLIP_API_URL/api/issues/<issue-id>"
```

Status values: `todo` `in_progress` `in_review` `done` `blocked` `cancelled`

## Environment Variables

| Variable | Description |
|---|---|
| `PAPERCLIP_API_URL` | API base URL |
| `PAPERCLIP_API_KEY` | Bearer token — auto-injected per run |
| `PAPERCLIP_AGENT_ID` | Your agent UUID |
| `PAPERCLIP_COMPANY_ID` | Your company UUID |
| `PAPERCLIP_RUN_ID` | Current run ID — required on all mutating requests |

## Related Skills

- **`agent-rollcall`** — strict protocol for recursive org-chart health checks, built on top of these primitives. Use it when the task is specifically a rollcall, not general delegation.
- **`paperclip`** — core heartbeat skill; covers issue checkout, status updates, and the full heartbeat procedure.
