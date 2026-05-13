---
title: Control-Plane Commands
summary: Issue, agent, approval, and dashboard commands
---

Client-side commands for managing issues, agents, approvals, and more.

## Issue Commands

```sh
# List issues
pnpm odysseus issue list [--status todo,in_progress] [--assignee-agent-id <id>] [--match text]

# Get issue details
pnpm odysseus issue get <issue-id-or-identifier>

# Create issue
pnpm odysseus issue create --title "..." [--description "..."] [--status todo] [--priority high]

# Update issue
pnpm odysseus issue update <issue-id> [--status in_progress] [--comment "..."]

# Add comment
pnpm odysseus issue comment <issue-id> --body "..." [--reopen]

# Checkout task
pnpm odysseus issue checkout <issue-id> --agent-id <agent-id>

# Release task
pnpm odysseus issue release <issue-id>
```

## Company Commands

```sh
pnpm odysseus company list
pnpm odysseus company get <company-id>

# Export to portable folder package (writes manifest + markdown files)
pnpm odysseus company export <company-id> --out ./exports/acme --include company,agents

# Preview import (no writes)
pnpm odysseus company import \
  <owner>/<repo>/<path> \
  --target existing \
  --company-id <company-id> \
  --ref main \
  --collision rename \
  --dry-run

# Apply import
pnpm odysseus company import \
  ./exports/acme \
  --target new \
  --new-company-name "Acme Imported" \
  --include company,agents
```

## Agent Commands

```sh
pnpm odysseus agent list
pnpm odysseus agent get <agent-id>
```

## Approval Commands

```sh
# List approvals
pnpm odysseus approval list [--status pending]

# Get approval
pnpm odysseus approval get <approval-id>

# Create approval
pnpm odysseus approval create --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]

# Approve
pnpm odysseus approval approve <approval-id> [--decision-note "..."]

# Reject
pnpm odysseus approval reject <approval-id> [--decision-note "..."]

# Request revision
pnpm odysseus approval request-revision <approval-id> [--decision-note "..."]

# Resubmit
pnpm odysseus approval resubmit <approval-id> [--payload '{"..."}']

# Comment
pnpm odysseus approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm odysseus activity list [--agent-id <id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard

```sh
pnpm odysseus dashboard get
```

## Heartbeat

```sh
pnpm odysseus heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100]
```
