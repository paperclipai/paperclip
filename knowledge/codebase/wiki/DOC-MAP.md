# Project documentation map (repo → OpenKnowledge)

Inventory of existing nomandyOS / Paperclip docs. Paths are relative to repo root `/Users/jcafeitosa/Development/nomandyOS`.
OK vault content-dir is `knowledge/` — this map is the index; do not duplicate `releases/` into the vault.

## Root
| Path | Role |
|---|---|
| `README.md` | Product entry |
| `AGENTS.md` | Agent conventions for this checkout |
| `CONTRIBUTING.md` | Contribution guide |

## Product docs (`docs/`) — canonical
### Start
- `docs/start/what-is-paperclip.md`
- `docs/start/quickstart.md`
- `docs/start/architecture.md`
- `docs/start/core-concepts.md`

### Deploy
- `docs/deploy/overview.md`
- `docs/deploy/local-development.md`
- `docs/deploy/docker.md`
- `docs/deploy/database.md`
- `docs/deploy/environment-variables.md`
- `docs/deploy/secrets.md`
- `docs/deploy/storage.md`
- `docs/deploy/deployment-modes.md`
- `docs/deploy/aws-ecs.md`
- `docs/deploy/tailscale-private-access.md`
- `docs/deploy/dev-plane-restart-hygiene.md`

### API
- `docs/api/overview.md` + agents, issues, companies, goals-and-projects, authentication, secrets, secrets-remote-import, approvals, activity, costs, dashboard, routines

### Adapters / runtime
- `docs/adapters/overview.md` + creating-an-adapter, external-adapters, process, http, claude-local, codex-local, gemini-local, kimi-local, adapter-ui-parser
- `docs/agents-runtime.md`
- `docs/built-in-agents.md`
- `docs/cli/overview.md`, `docs/cli/setup-commands.md`, `docs/cli/control-plane-commands.md`

### Guides
- Board operator: `docs/guides/board-operator/*` (dashboard, tasks, agents, org-structure, approvals, costs, delegation, workspaces, import/export, …)
- Agent developer: `docs/guides/agent-developer/*` (heartbeat, task-workflow, skills, MCP smoke, approvals, costs, comments)
- `docs/guides/execution-policy.md`
- `docs/guides/openclaw-docker-setup.md`
- `docs/pipelines-tutorial.md`
- `docs/feedback-voting.md`
- `docs/companies/companies-spec.md`

### Specs / plans (active)
- `docs/specs/external-task-protocol.md`
- `docs/specs/agent-config-ui.md`
- `docs/specs/cliphub-plan.md`
- `docs/plans/2026-03-13-issue-documents-plan.md`
- **Migration (priority):** `docs/superpowers/plans/2026-09-03-bun-elysia-migration-plan.md`
- **Migration inventory:** `docs/superpowers/plans/2026-09-04-bun-elysia-migration-inventory.md`

## Already in OK vault (`knowledge/`)
### Org (nomandyOS ops)
- `knowledge/articles/org/tool-routing.md`
- `knowledge/articles/org/no-silent-work.md`
- `knowledge/articles/org/roster.md`
- `knowledge/articles/org/agent-resources.md`
- `knowledge/articles/org/cli-howto.md`
- `knowledge/articles/org/migration-sources-2026-09-05.md`
- `knowledge/articles/org/ok-brain-policy.md`

### Codebase wiki
- `knowledge/codebase/wiki/OVERVIEW.md` (seed)
- Start summaries (NOM-27): `concepts/what-is-paperclip.md`, `concepts/core-concepts.md`, `concepts/quickstart.md` → link `docs/start/*`
- Architecture summary (NOM-27): `architecture/overview.md` → link `docs/start/architecture.md`
- this file: `DOC-MAP.md`

### Lifecycle / research / external (templates ready)
- `knowledge/lifecycle/{decisions,guides,specs,proposals,postmortems}/`
- `knowledge/research/`, `knowledge/external-sources/`

## Out of vault (do not bulk-import)
| Area | Why |
|---|---|
| `releases/*.md` | Changelog noise — link from release process only |
| `.agents/skills`, `.cursor/skills`, `.claude/skills`, `.opencode/skills` | Skill runtime, not product KB (many duplicates) |
| `ui/**/README.md`, `tests/**/README.md`, `docker/**/README.md` | Local package readmes — cite when needed |
| `evals/**` | Eval artifacts |

## Next ingestion (board children)
1. ~~Promote start+architecture summaries~~ — done NOM-27 (wiki concepts + architecture/overview).
2. Clip migration plan/inventory into `knowledge/lifecycle/specs/` or wiki flows (NOM-11).
3. Run `codebase-wiki` generate/refresh for modules after Bun/Elysia slices land.
4. `ok lint knowledge/` + `ok audit` after each batch.

