---
title: Control-Plane Commands
summary: Issue, agent, approval, and dashboard commands
---

Client-side commands for managing issues, agents, approvals, and more.

## Issue Commands

```sh
# List issues
pnpm valadrien-os issue list [--status todo,in_progress] [--assignee-agent-id <id>] [--match text]

# Get issue details
pnpm valadrien-os issue get <issue-id-or-identifier>

# Create issue
pnpm valadrien-os issue create --title "..." [--description "..."] [--status todo] [--priority high]

# Update issue
pnpm valadrien-os issue update <issue-id> [--status in_progress] [--comment "..."]

# Add comment
pnpm valadrien-os issue comment <issue-id> --body "..." [--reopen]

# Checkout task
pnpm valadrien-os issue checkout <issue-id> --agent-id <agent-id>

# Release task
pnpm valadrien-os issue release <issue-id>
```

## Company Commands

```sh
pnpm valadrien-os company list
pnpm valadrien-os company get <company-id>

# Export to portable folder package (writes manifest + markdown files)
pnpm valadrien-os company export <company-id> --out ./exports/acme --include company,agents

# Preview import (no writes)
pnpm valadrien-os company import \
  <owner>/<repo>/<path> \
  --target existing \
  --company-id <company-id> \
  --ref main \
  --collision rename \
  --dry-run

# Apply import
pnpm valadrien-os company import \
  ./exports/acme \
  --target new \
  --new-company-name "Acme Imported" \
  --include company,agents
```

## Agent Commands

```sh
pnpm valadrien-os agent list
pnpm valadrien-os agent get <agent-id>
```

## Approval Commands

```sh
# List approvals
pnpm valadrien-os approval list [--status pending]

# Get approval
pnpm valadrien-os approval get <approval-id>

# Create approval
pnpm valadrien-os approval create --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]

# Approve
pnpm valadrien-os approval approve <approval-id> [--decision-note "..."]

# Reject
pnpm valadrien-os approval reject <approval-id> [--decision-note "..."]

# Request revision
pnpm valadrien-os approval request-revision <approval-id> [--decision-note "..."]

# Resubmit
pnpm valadrien-os approval resubmit <approval-id> [--payload '{"..."}']

# Comment
pnpm valadrien-os approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm valadrien-os activity list [--agent-id <id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard

```sh
pnpm valadrien-os dashboard get
```

## Heartbeat

```sh
pnpm valadrien-os heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100]
```
