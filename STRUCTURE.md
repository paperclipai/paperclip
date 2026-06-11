# Paperclip — Repository Structure

> Canonical map of this repo. If a directory's purpose is unclear, it should be
> documented here. For *what Paperclip is*, see [`README.md`](./README.md).

Paperclip is a **control plane for orchestrating teams of AI agents into
autonomous companies** — multi-company, board-governed, org-chart driven,
heartbeat-based execution, bring-your-own-agent via adapters.

TypeScript monorepo · **pnpm 9.15.4** · Node ≥20 · Vitest + Playwright · TS
project references. Workspaces are defined in
[`pnpm-workspace.yaml`](./pnpm-workspace.yaml).

---

## Apps

| Dir | Package | Role |
|-----|---------|------|
| [`cli/`](./cli) | `paperclipai` | CLI orchestrator. Entry `cli/src/index.ts`, bundled with esbuild. |
| [`server/`](./server) | `@paperclipai/server` | Express 5 backend — task execution, agent runtime, realtime. Entry `server/src/index.ts`. Runs DB migrations on startup. |
| [`ui/`](./ui) | `@paperclipai/ui` | React 19 + Vite SPA (the board). Tailwind 4 + shadcn/ui + Storybook. |

## Shared libraries — `packages/`

| Dir | Package | Role |
|-----|---------|------|
| [`packages/shared`](./packages/shared) | `@paperclipai/shared` | Zod schemas, shared types, telemetry. |
| [`packages/db`](./packages/db) | `@paperclipai/db` | Drizzle ORM, Postgres, migrations, seeding. |
| [`packages/adapter-utils`](./packages/adapter-utils) | `@paperclipai/adapter-utils` | Helpers shared across adapters. |
| [`packages/mcp-server`](./packages/mcp-server) | `@paperclipai/mcp-server` | MCP stdio server. |

## Adapters — `packages/adapters/` (10)

LLM provider bridges, all named `@paperclipai/adapter-<provider>-<mode>`. Each
exports `./server`, `./ui`, `./cli` subentries and carries its own `skills/`.

`acpx-local` · `claude-local` · `codex-local` · `cursor-local` · `cursor-cloud`
· `gemini-local` · `grok-local` · `opencode-local` · `pi-local` ·
`openclaw-gateway`

## Plugins — `packages/plugins/`

| Dir | Role |
|-----|------|
| [`sdk`](./packages/plugins/sdk) | Stable public plugin API (v1.0.0) — protocol, types, UI hooks, testing, bundlers, dev-server CLI. |
| [`create-paperclip-plugin`](./packages/plugins/create-paperclip-plugin) | Scaffolder for new plugins. |
| `plugin-llm-wiki`, `plugin-workspace-diff` | Concrete first-party plugins. |
| `paperclip-plugin-fake-sandbox` | Test fixture. |
| `examples/` | 5 example plugins (hello-world, kitchen-sink, file-browser, …). |
| `sandbox-providers/` | **Workspace-excluded** island (standalone deps). |

## Catalogs

| Dir | Package | Role |
|-----|---------|------|
| [`packages/skills-catalog`](./packages/skills-catalog) | `@paperclipai/skills-catalog` | Generated skills manifest + types. |
| [`packages/teams-catalog`](./packages/teams-catalog) | `@paperclipai/teams-catalog` | Generated team-definitions manifest. |

## Support directories

| Dir | Role |
|-----|------|
| [`scripts/`](./scripts) | Build, release, smoke-test, utility scripts (~42). |
| [`tests/`](./tests) | Playwright `e2e/` + `release-smoke/`. |
| [`docker/`](./docker) | Compose, Quadlet, ECS task definitions. |
| [`releases/`](./releases) | Release notes. |
| [`skills/`](./skills) | First-party orchestration skills (`paperclip`, `paperclip-dev`, …). |
| [`evals/`](./evals) | Evaluation fixtures. |
| `patches/` | pnpm patch (embedded-postgres). |
| `.claude/`, `.agents/` | Claude Code harness config / agent definitions. |

## Documentation — read this before adding docs

Paperclip keeps two intentional documentation roots. **The boundary is a rule,
not an accident** — follow it so the two never drift again.

| Folder | Charter | Audience |
|--------|---------|----------|
| [`docs/`](./docs) | **Published, user-facing — single source of truth.** Mintlify-rendered (`docs/docs.json`). Anything an operator, agent-developer, or deployer reads. | End users |
| [`doc/`](./doc) | **Internal engineering** — deep design specs, RFC-style plans, experiments. Never re-explains a user-facing concept; links to `docs/` instead. | Contributors |

Each root has a `README.md` stating its charter. The
`doc/DEPLOYMENT-MODES.md` ↔ `docs/deploy/deployment-modes.md` pair is the
**model to copy**: canonical internal design in `doc/`, user summary in `docs/`,
cross-linked both ways.

> **Note:** `claude-docs/` (untracked) is scratch output, not a documentation
> root. Do not add canonical docs there.

## Domain model — the 12-system control plane

Identity/Access · Org-chart/Agents · Work/Tasks (initiative→project→milestone→issue→sub-issue)
· Heartbeat execution · Workspaces/Runtime · Governance/Approvals · Budget/Cost
· Routines/Schedules · Plugins · Secrets/Storage · Activity/Audit · Company
portability.

See [`doc/SPEC.md`](./doc/SPEC.md) and [`docs/start/architecture.md`](./docs/start/architecture.md).
