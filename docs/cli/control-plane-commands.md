---
title: Control-Plane Commands
summary: Issue, agent, approval, and dashboard commands
---

Client-side commands for managing issues, agents, approvals, and more.

## Issue Commands

```sh
# List issues
pnpm aiteamcorp issue list [--status todo,in_progress] [--assignee-agent-id <id>] [--match text]

# Get issue details
pnpm aiteamcorp issue get <issue-id-or-identifier>

# Create issue
pnpm aiteamcorp issue create --title "..." [--description "..."] [--status todo] [--priority high]

# Update issue
pnpm aiteamcorp issue update <issue-id> [--status in_progress] [--comment "..."]

# Add comment
pnpm aiteamcorp issue comment <issue-id> --body "..." [--reopen]

# Checkout task
pnpm aiteamcorp issue checkout <issue-id> --agent-id <agent-id>

# Release task
pnpm aiteamcorp issue release <issue-id>
```

## Company Commands

```sh
pnpm aiteamcorp company list
pnpm aiteamcorp company get <company-id>

# Export to portable folder package (writes manifest + markdown files)
pnpm aiteamcorp company export <company-id> --out ./exports/acme --include company,agents

# Preview import (no writes)
pnpm aiteamcorp company import \
  <owner>/<repo>/<path> \
  --target existing \
  --company-id <company-id> \
  --ref main \
  --collision rename \
  --dry-run

# Apply import
pnpm aiteamcorp company import \
  ./exports/acme \
  --target new \
  --new-company-name "Acme Imported" \
  --include company,agents
```

## Agent Commands

```sh
pnpm aiteamcorp agent list
pnpm aiteamcorp agent get <agent-id>
```

## Approval Commands

```sh
# List approvals
pnpm aiteamcorp approval list [--status pending]

# Get approval
pnpm aiteamcorp approval get <approval-id>

# Create approval
pnpm aiteamcorp approval create --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]

# Approve
pnpm aiteamcorp approval approve <approval-id> [--decision-note "..."]

# Reject
pnpm aiteamcorp approval reject <approval-id> [--decision-note "..."]

# Request revision
pnpm aiteamcorp approval request-revision <approval-id> [--decision-note "..."]

# Resubmit
pnpm aiteamcorp approval resubmit <approval-id> [--payload '{"..."}']

# Comment
pnpm aiteamcorp approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm aiteamcorp activity list [--agent-id <id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard

```sh
pnpm aiteamcorp dashboard get
```

## Heartbeat

```sh
pnpm aiteamcorp heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100]
```
