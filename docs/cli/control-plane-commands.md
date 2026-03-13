---
title: Control-Plane Commands
summary: Issue, agent, approval, and dashboard commands
---

Client-side commands for managing issues, agents, approvals, and more.

## Issue Commands

```sh
# List issues
pnpm paperclipai issue list [--status todo,in_progress] [--assignee-agent-id <id>] [--match text]

# Get issue details
pnpm paperclipai issue get <issue-id-or-identifier>

# Create issue
pnpm paperclipai issue create --title "..." [--description "..."] [--status todo] [--priority high]

# Update issue
pnpm paperclipai issue update <issue-id> [--status in_progress] [--comment "..."]

# Add comment
pnpm paperclipai issue comment <issue-id> --body "..." [--reopen]

# Checkout task
pnpm paperclipai issue checkout <issue-id> --agent-id <agent-id>

# Release task
pnpm paperclipai issue release <issue-id>
```

## Company Commands

```sh
pnpm paperclipai company list
pnpm paperclipai company get <company-id>

# Export to portable folder package (writes manifest + markdown files)
pnpm paperclipai company export <company-id> --out ./exports/acme --include company,agents

# Preview import (no writes)
pnpm paperclipai company import \
  --from https://github.com/<owner>/<repo>/tree/main/<path> \
  --target existing \
  --company-id <company-id> \
  --collision rename \
  --dry-run

# Apply import
pnpm paperclipai company import \
  --from ./exports/acme \
  --target new \
  --new-company-name "Acme Imported" \
  --include company,agents
```

## Agent Commands

```sh
pnpm paperclipai agent list
pnpm paperclipai agent get <agent-id>
```

## Approval Commands

```sh
# List approvals
pnpm paperclipai approval list [--status pending]

# Get approval
pnpm paperclipai approval get <approval-id>

# Create approval
pnpm paperclipai approval create --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]

# Approve
pnpm paperclipai approval approve <approval-id> [--decision-note "..."]

# Reject
pnpm paperclipai approval reject <approval-id> [--decision-note "..."]

# Request revision
pnpm paperclipai approval request-revision <approval-id> [--decision-note "..."]

# Resubmit
pnpm paperclipai approval resubmit <approval-id> [--payload '{"..."}']

# Comment
pnpm paperclipai approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm paperclipai activity list [--agent-id <id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard

```sh
pnpm paperclipai dashboard get
```

## Node Commands

```sh
# Register a new remote node
pnpm paperclipai node register <name> -C <company-id> [--capabilities '{"browser":true}']

# List registered nodes
pnpm paperclipai node list -C <company-id>

# Show node details
pnpm paperclipai node status <node-id> [-C <company-id>]

# Run the node daemon (claims and executes remote agent runs)
pnpm paperclipai node run \
  --node-id <id> \
  --api-url <url> \
  --api-key <key> \
  [--max-concurrent <n>]
```

The `node run` command can also read from environment variables:

| Flag | Env Variable |
|------|-------------|
| `--node-id` | `PAPERCLIP_NODE_ID` |
| `--api-url` | `PAPERCLIP_API_URL` |
| `--api-key` | `PAPERCLIP_NODE_KEY` |

## Heartbeat

```sh
pnpm paperclipai heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100]
```
