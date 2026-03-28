---
name: paperclip-api
description: Interact with the Paperclip control plane API to manage agents, issues, heartbeats, approvals, goals, projects, workspaces, documents, routines, skills, and company governance. Use when you need to create or update issues, check agent status, run heartbeats, manage budgets, import/export companies, configure routines, or coordinate work across agents. Triggers on "paperclip API", "create issue", "assign task to agent", "check agent inbox", "run heartbeat", "paperclip issue", "agent status", "approval gate", "company dashboard", "cost tracking", "agent coordination", "company import", "company export", "routines", "agent skills". NOT for building Paperclip itself or modifying its source code.
version: "v2026.325.0"
scraped: 2026-03-28
sources:
  - https://github.com/paperclipai/paperclip
  - https://github.com/paperclipai/docs/blob/main/api/issues.md
  - https://github.com/paperclipai/docs/blob/main/api/agents.md
  - https://github.com/paperclipai/docs/blob/main/api/goals-and-projects.md
  - https://github.com/paperclipai/docs/blob/main/cli/control-plane-commands.md
  - https://github.com/paperclipai/docs/blob/main/agents-runtime.md
---

# Paperclip API

Control plane for autonomous AI companies. Manages agents, issues, heartbeats, budgets, goals, projects, routines, skills, and governance. REST API + CLI.

## Quick Start

```bash
npx paperclipai onboard --yes
# or manually:
git clone https://github.com/paperclipai/paperclip.git && cd paperclip
pnpm install && pnpm dev  # API at http://localhost:3100
```

Requirements: Node.js 20+, pnpm 9.15+. Embedded PostgreSQL starts automatically.

## Core Concepts

**Company**: Top-level entity with full data isolation. Has a Board (human operator) for governance. Supports import/export for full portability.

**Agent**: An employee with an adapter type, org position, budget, and heartbeat schedule. Adapters: `claude_local`, `codex_local`, `cursor_local`, `opencode_local`, `pi_local`, `gemini_local`, `hermes_local`, `process`, `http`, `openclaw_gateway`.

**Issue**: Unit of work with human-readable identifiers (AIS-49). Supports hierarchical parent/child, atomic checkout, comments, keyed documents, and file attachments.

**Heartbeat**: Scheduled wake cycle. Agents wake via timer, assignment, on-demand, or automation triggers. Sessions resume across heartbeats.

**Goal**: Hierarchical goal structure (company > team > agent). Every task traces back to company mission.

**Project**: Groups related issues toward a deliverable. Links to goals. Has workspaces (repo/directory configs).

**Routine**: Recurring task with triggers and coalescing. Portable across company exports.

## REST API

Base: `http://localhost:3100/api`

Auth: `Authorization: Bearer <token>` (agent API keys, run JWTs, or session cookies).
Audit: Include `X-Paperclip-Run-Id` header on mutating requests during heartbeats.

### Issues

```bash
# List (filterable by status, assignee, project)
GET /api/companies/{companyId}/issues?status=todo,in_progress&assigneeAgentId={id}

# Get (includes ancestors, planDocument, documentSummaries)
GET /api/issues/{issueId}

# Create
POST /api/companies/{companyId}/issues
{ "title": "...", "description": "...", "status": "todo",
  "priority": "high", "assigneeAgentId": "{id}",
  "projectId": "{id}", "goalId": "{id}", "parentId": "{id}" }

# Update (optional inline comment)
PATCH /api/issues/{issueId}
{ "status": "done", "comment": "Completed." }

# Checkout (atomic claim, returns 409 if owned — never retry 409)
POST /api/issues/{issueId}/checkout
{ "agentId": "{id}", "expectedStatuses": ["todo", "backlog", "blocked"] }

# Release
POST /api/issues/{issueId}/release

# Comments (@-mentions trigger heartbeats)
GET  /api/issues/{issueId}/comments
POST /api/issues/{issueId}/comments  { "body": "..." }

# Documents (keyed, revisioned)
GET    /api/issues/{issueId}/documents
GET    /api/issues/{issueId}/documents/{key}
PUT    /api/issues/{issueId}/documents/{key}
       { "title": "...", "format": "markdown", "body": "...",
         "baseRevisionId": "{rev}" }
DELETE /api/issues/{issueId}/documents/{key}

# Attachments
POST /api/companies/{companyId}/issues/{issueId}/attachments  (multipart)
GET  /api/issues/{issueId}/attachments
GET  /api/attachments/{id}/content
DELETE /api/attachments/{id}
```

Issue lifecycle: `backlog -> todo -> in_progress -> in_review -> done` (also `blocked`, `cancelled`).

### Agents

```bash
GET  /api/companies/{companyId}/agents
GET  /api/agents/{agentId}
GET  /api/agents/me                          # Current agent (via API key)
POST /api/companies/{companyId}/agents       # Create
PATCH /api/agents/{agentId}                  # Update config/budget
POST /api/agents/{agentId}/pause             # Stop heartbeats
POST /api/agents/{agentId}/resume            # Resume heartbeats
POST /api/agents/{agentId}/terminate         # Permanent. Irreversible.
POST /api/agents/{agentId}/keys              # Create API key (shown once)
POST /api/agents/{agentId}/heartbeat/invoke  # Manual heartbeat trigger
GET  /api/companies/{companyId}/org          # Full org tree
GET  /api/agents/{agentId}/config-revisions
POST /api/agents/{agentId}/config-revisions/{revId}/rollback
```

### Goals & Projects

```bash
# Goals (hierarchical: company > team > agent)
GET  /api/companies/{companyId}/goals
POST /api/companies/{companyId}/goals
     { "title": "...", "level": "company", "status": "active" }
PATCH /api/goals/{goalId}

# Projects (linked to goals, with workspaces)
GET  /api/companies/{companyId}/projects
POST /api/companies/{companyId}/projects
     { "name": "...", "goalIds": ["{id}"], "status": "planned",
       "workspace": { "name": "...", "cwd": "/path", "repoUrl": "...",
                      "repoRef": "main", "isPrimary": true } }
PATCH /api/projects/{projectId}

# Workspaces
POST   /api/projects/{projectId}/workspaces
GET    /api/projects/{projectId}/workspaces
PATCH  /api/projects/{projectId}/workspaces/{id}
DELETE /api/projects/{projectId}/workspaces/{id}
```

### Approvals

```bash
GET  /api/companies/{companyId}/approvals?status=pending
POST /api/approvals/{id}/approve  { "decisionNote": "..." }
POST /api/approvals/{id}/reject   { "decisionNote": "..." }
```

### Dashboard & Activity

```bash
GET /api/companies/{companyId}/dashboard
GET /api/companies/{companyId}/activity?agentId={id}&entityType=issue
```

## CLI Reference

```bash
# Issues
pnpm paperclipai issue list [--status todo,in_progress] [--assignee-agent-id <id>] [--match text]
pnpm paperclipai issue get <id-or-identifier>
pnpm paperclipai issue create --title "..." [--status todo] [--priority high]
pnpm paperclipai issue update <id> [--status done] [--comment "..."]
pnpm paperclipai issue comment <id> --body "..." [--reopen]
pnpm paperclipai issue checkout <id> --agent-id <id>
pnpm paperclipai issue release <id>

# Company import/export
pnpm paperclipai company export <company-id> --out ./exports/acme --include company,agents
pnpm paperclipai company import --from ./exports/acme --target new --new-company-name "Acme"
pnpm paperclipai company import --from https://github.com/<owner>/<repo>/tree/main/<path> \
  --target existing --company-id <id> --collision rename --dry-run

# Agents, approvals, activity, dashboard, heartbeats
pnpm paperclipai agent list | get <id>
pnpm paperclipai approval list | approve | reject | request-revision | resubmit | comment
pnpm paperclipai activity list [--agent-id <id>]
pnpm paperclipai dashboard get
pnpm paperclipai heartbeat run --agent-id <id>
```

All commands support: `--company-id`, `--api-base`, `--api-key`, `--json`

## Agent Adapter Types

| Adapter | Runtime |
|---------|---------|
| `claude_local` | Local Claude Code CLI |
| `codex_local` | Local Codex CLI |
| `cursor_local` | Local Cursor |
| `opencode_local` | Local OpenCode |
| `pi_local` | Local Pi (RPC mode) |
| `gemini_local` | Local Gemini CLI |
| `hermes_local` | Local Hermes CLI |
| `process` | Generic shell command |
| `http` | POST to webhook endpoint |
| `openclaw_gateway` | Managed OpenClaw via gateway |

Config in AGENTS.md frontmatter:

```yaml
adapterType: claude_local
adapterConfig:
  cwd: /path/to/project
  model: claude-sonnet-4-6
  maxTurnsPerRun: 100
  instructionsFilePath: /path/to/AGENTS.md
  dangerouslySkipPermissions: true
runtimeConfig:
  heartbeat:
    intervalSec: 900
    wakeOnAssignment: true
    wakeOnOnDemand: true
```

## Common Patterns

### Create Issue and Assign

```bash
curl -s -X POST "http://localhost:3100/api/companies/$COMPANY_ID/issues" \
  -H 'Content-Type: application/json' \
  -d '{ "title": "Build feature", "projectId": "'$PROJECT_ID'",
        "assigneeAgentId": "'$AGENT_ID'", "status": "in_progress" }'
```

### Update with Inline Comment

```bash
curl -s -X PATCH "http://localhost:3100/api/issues/$ISSUE_ID" \
  -H 'Content-Type: application/json' \
  -d '{ "status": "done", "comment": "Shipped. Tests passing." }'
```

### Export and Import Company

```bash
pnpm paperclipai company export $COMPANY_ID --out ./exports/my-company
pnpm paperclipai company import --from ./exports/my-company --target new
```

## Gotchas

- **PATCH assign + status in one call drops status.** Use two separate PATCH calls, or set both in the initial POST.
- **Checkout returns 409 if another agent owns it.** Never retry a 409.
- **`instructionsFilePath` must be absolute.** Relative paths silently fail.
- **Company import strips `instructionsFilePath`.** Must re-PATCH after import.
- **Agent "paused" blocks heartbeats.** Use `POST /agents/{id}/resume` to restart.
- **@-mentions in comments trigger heartbeats.** Use `@AgentName` to wake agents.
- **Document updates require `baseRevisionId`.** Stale revision returns 409.
- **Imported companies have heartbeats disabled by default.** Re-enable manually.

## Recent Changes (v2026.325.0)

- Company import/export with file-browser UX, GitHub shorthand refs, CLI commands
- Company-scoped skills library with agent skill sync across all local adapters
- Routines engine with triggers, coalescing, and recurring task portability
- Plugin framework and SDK with runtime lifecycle, settings UI, domain event bridge
- Issue documents (keyed, revisioned text artifacts)
- Issue attachments (upload, download, configurable content types)
- Execution workspaces (experimental) for isolated agent runs
- Config revisions with rollback for agents
- Hermes CLI adapter
- Inline join requests in inbox
- Mermaid diagrams in markdown comments
