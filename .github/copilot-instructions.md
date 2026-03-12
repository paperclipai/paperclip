# Copilot Instructions for Paperclip

Paperclip is the control plane for autonomous AI companies. One instance runs
multiple companies, each with agents organized in an org chart.

## Repository Layout

- `server/` — Express REST API and orchestration services
- `ui/` — React + Vite board UI
- `packages/db/` — Drizzle schema, migrations, DB clients
- `packages/shared/` — Shared types, constants, validators, API path constants
- `packages/adapters/` — Agent execution adapters (claude-local, codex-local, copilot-cli, etc.)
- `cli/` — CLI tool (`paperclipai`) for setup, diagnostics, and control-plane operations
- `skills/` — Skill definitions that agents can use (Paperclip heartbeat, agent creation, etc.)
- `doc/` — Operational and product documentation

## Quick Start

```sh
pnpm install
pnpm dev          # starts API + UI at http://localhost:3100
```

Health check: `curl http://localhost:3100/api/health`

## Key Concepts

- **Company** — top-level organizational entity; all resources are company-scoped
- **Agent** — AI employee with an adapter type, config, role, and reporting chain
- **Issue** — task/work item with status lifecycle, assigned to agents
- **Heartbeat** — short execution window triggered by Paperclip for an agent
- **Adapter** — execution backend (claude_local, codex_local, copilot_cli, process, http, etc.)
- **Approval** — governance gate for agent-initiated changes (e.g., hire_agent)

## API Base Path

All endpoints are under `/api`. Agent requests use `Authorization: Bearer <API_KEY>`.

## Common Patterns

- Always scope queries by company ID
- Use `POST /api/issues/{id}/checkout` before working on a task
- Include `X-Paperclip-Run-Id` header on mutating issue requests during heartbeats
- Create subtasks with `parentId` and `goalId` set

## Verification

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

## Adding an Adapter

1. Create package under `packages/adapters/<name>/`
2. Export: `type`, `label`, `models`, `agentConfigurationDoc` from index
3. Implement `execute` and `testEnvironment` in `server/` subpath
4. Register in `server/src/adapters/registry.ts`
5. Add UI adapter in `ui/src/adapters/`
6. Add adapter type to `AGENT_ADAPTER_TYPES` in `packages/shared/src/constants.ts`

## Documentation References

- `doc/GOAL.md` — Project vision
- `doc/PRODUCT.md` — Product definition
- `doc/SPEC-implementation.md` — V1 build contract
- `doc/DEVELOPING.md` — Development setup
- `doc/CLI.md` — CLI command reference
