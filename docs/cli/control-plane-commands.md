---
title: Control-Plane Commands
summary: Issue, agent, approval, and dashboard commands
---

Client-side commands for managing issues, agents, approvals, and more.

## Issue Commands

```sh
# List issues
pnpm ironworksai issue list [--status todo,in_progress] [--assignee-agent-id <id>] [--match text]

# Get issue details
pnpm ironworksai issue get <issue-id-or-identifier>

# Create issue
pnpm ironworksai issue create --title "..." [--description "..."] [--status todo] [--priority high]

# Update issue
pnpm ironworksai issue update <issue-id> [--status in_progress] [--comment "..."]

# Add comment
pnpm ironworksai issue comment <issue-id> --body "..." [--reopen]

# Checkout task
pnpm ironworksai issue checkout <issue-id> --agent-id <agent-id>

# Release task
pnpm ironworksai issue release <issue-id>
```

## Company Commands

```sh
pnpm ironworksai company list
pnpm ironworksai company get <company-id>

# Export to portable folder package (writes manifest + markdown files)
pnpm ironworksai company export <company-id> --out ./exports/acme --include company,agents

# Preview import (no writes)
pnpm ironworksai company import \
  <owner>/<repo>/<path> \
  --target existing \
  --company-id <company-id> \
  --ref main \
  --collision rename \
  --dry-run

# Apply import
pnpm ironworksai company import \
  ./exports/acme \
  --target new \
  --new-company-name "Acme Imported" \
  --include company,agents
```

## Agent Commands

```sh
pnpm ironworksai agent list
pnpm ironworksai agent get <agent-id>
```

## Approval Commands

```sh
# List approvals
pnpm ironworksai approval list [--status pending]

# Get approval
pnpm ironworksai approval get <approval-id>

# Create approval
pnpm ironworksai approval create --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]

# Approve
pnpm ironworksai approval approve <approval-id> [--decision-note "..."]

# Reject
pnpm ironworksai approval reject <approval-id> [--decision-note "..."]

# Request revision
pnpm ironworksai approval request-revision <approval-id> [--decision-note "..."]

# Resubmit
pnpm ironworksai approval resubmit <approval-id> [--payload '{"..."}']

# Comment
pnpm ironworksai approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm ironworksai activity list [--agent-id <id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard

```sh
pnpm ironworksai dashboard get
```

## Heartbeat

```sh
pnpm ironworksai heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100]
```
