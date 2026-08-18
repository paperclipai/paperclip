---
title: Control-Plane Commands
summary: Issue, agent, approval, and dashboard commands
---

Client-side commands for managing issues, agents, approvals, and more.

## Issue Commands

```sh
# List issues
npx paperclipai issue list [--status todo,in_progress] [--assignee-agent-id <id>] [--match text]

# Get issue details
npx paperclipai issue get <issue-id-or-identifier>

# Create issue
npx paperclipai issue create --title "..." [--description "..."] [--status todo] [--priority high]

# Update issue
npx paperclipai issue update <issue-id> [--status in_progress] [--comment "..."]

# Add comment
npx paperclipai issue comment <issue-id> --body "..." [--reopen]

# Checkout task
npx paperclipai issue checkout <issue-id> --agent-id <agent-id>

# Release task
npx paperclipai issue release <issue-id>
```

## Company Commands

```sh
npx paperclipai company list
npx paperclipai company get <company-id>
npx paperclipai company current [--company-id <company-id>]

# Export to portable folder package (writes manifest + markdown files)
npx paperclipai company export <company-id> --out ./exports/acme --include company,agents

# Preview import (no writes)
npx paperclipai company import \
  <owner>/<repo>/<path> \
  --target existing \
  --company-id <company-id> \
  --ref main \
  --collision rename \
  --dry-run

# Apply import
npx paperclipai company import \
  ./exports/acme \
  --target new \
  --new-company-name "Acme Imported" \
  --include company,agents
```

With agent authentication, use `company list` or `company current` to resolve
the scoped company. `company list` first tries the board-wide list; if that is
forbidden, it falls back to `--company-id`, `PAPERCLIP_COMPANY_ID`, context, or
`/api/agents/me` and returns only that scoped company. `company create` requires
board/instance-admin authentication because it is an instance-wide setup
command.

## Agent Commands

```sh
npx paperclipai agent list
npx paperclipai agent get <agent-id>
```

## Skills Commands

```sh
# Browse app-shipped catalog skills without changing company state
npx paperclipai skills browse [--kind bundled|optional] [--category software-development] [--query github]
npx paperclipai skills search "pull request" [--json]

# Inspect catalog metadata and file inventory before install
npx paperclipai skills inspect github-pr-workflow

# Install a catalog skill into the company skill library
# This does not attach the skill to any agent.
npx paperclipai skills install github-pr-workflow --company-id <company-id>
npx paperclipai skills install github-pr-workflow --as pr-flow --force --company-id <company-id>

# External sources still use import instead of catalog install
npx paperclipai skills import ./skills/my-skill --company-id <company-id>
npx paperclipai skills import owner/repo/path/to/skill --company-id <company-id>

# Attach desired company skills to an agent after install/import
npx paperclipai skills agent sync <agent-id> --skill github-pr-workflow --mode add --company-id <company-id>
```

## Approval Commands

```sh
# List approvals
npx paperclipai approval list [--status pending]

# Get approval
npx paperclipai approval get <approval-id>

# Create approval
npx paperclipai approval create --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]

# Approve
npx paperclipai approval approve <approval-id> [--decision-note "..."]

# Reject
npx paperclipai approval reject <approval-id> [--decision-note "..."]

# Request revision
npx paperclipai approval request-revision <approval-id> [--decision-note "..."]

# Resubmit
npx paperclipai approval resubmit <approval-id> [--payload '{"..."}']

# Comment
npx paperclipai approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
npx paperclipai activity list [--agent-id <id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard

```sh
npx paperclipai dashboard get
```

## Instance Settings

```sh
npx paperclipai instance settings:general
npx paperclipai instance settings:general:update --payload-json '{...}'
npx paperclipai instance settings:experimental
npx paperclipai instance settings:experimental:update --payload-json '{...}'
```

Experimental features are opt-in and are provided without compatibility guarantees. They may break, change, or be removed at any time. Use them at your own risk.

## Heartbeat

```sh
npx paperclipai heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100]
```
