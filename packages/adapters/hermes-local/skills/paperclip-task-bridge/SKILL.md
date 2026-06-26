---
name: paperclip-task-bridge
description: Create, comment on, update, and list Paperclip tasks from Hermes using scoped Paperclip API credentials.
---

# Paperclip Task Bridge

Use this skill when a Hermes-originated request needs to create or update Paperclip work directly. This is the Hermes-to-Paperclip direction, separate from Paperclip waking Hermes through the `hermes_local` or `hermes_gateway` adapter.

## Required Environment

Configure these in Hermes env/profile secrets, not in prompt text:

- `PAPERCLIP_API_URL` - Paperclip base URL, with or without `/api`.
- `PAPERCLIP_API_KEY` - scoped Paperclip agent API key for the Hermes actor.

Optional:

- `PAPERCLIP_COMPANY_ID` - skips one identity lookup when set.
- `PAPERCLIP_AGENT_ID` - skips one identity lookup when set.
- `PAPERCLIP_RUN_ID` - sent as `X-Paperclip-Run-Id` on mutating requests when Hermes is running inside a Paperclip heartbeat.

Never print or paste API keys. The helper reads credentials from environment variables and only prints response summaries.

## Helper

Run the helper from this skill directory:

```sh
node ./paperclip-task.mjs --help
```

Commands:

```sh
node ./paperclip-task.mjs list-assigned
node ./paperclip-task.mjs create-task --title "Investigate checkout failures" --description "Capture failing request and root cause."
node ./paperclip-task.mjs comment --issue PAP-123 --body "Found the failing request path."
node ./paperclip-task.mjs update-status --issue PAP-123 --status in_review --comment "Ready for review."
```

`create-task` defaults to assigning the task to the authenticated Hermes agent so the work is immediately actionable. Use `--unassigned` to create backlog work instead. Use `--assignee-agent-id <uuid>` only when the Paperclip API key has permission to assign work to that agent.

For multiline bodies, prefer files or stdin:

```sh
node ./paperclip-task.mjs create-task --title "Write rollout note" --description-file ./task.md
node ./paperclip-task.mjs comment --issue PAP-123 --body-file -
```

## Workflow Expectations

- Keep tasks company-scoped by using the company resolved from the scoped agent key.
- Let Paperclip activity logging come from the normal API endpoints; do not write local logs that include credentials.
- Use comments for durable progress.
- Use `update-status` only when the issue has a real disposition: `done`, `in_review`, `blocked`, `todo`, `in_progress`, `backlog`, or `cancelled`.
- Use `list-assigned` before creating duplicate work when the user asks about current Paperclip assignments.
