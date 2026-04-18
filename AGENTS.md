# AGENTS.md

Guidance for human and AI contributors working in this repository.

## 0. Project Management — Plane (MANDATORY)

**Every agent** (Claude Code, Codex, Antigravity, Cursor, or any future tool) **must** use Plane as the single source of truth for project management. No exceptions.

### Access

| Field | Value |
|-------|-------|
| URL | `http://plane.nexus.local` |
| API | `http://plane.nexus.local/api/v1` |
| Workspace | `nous` |
| Project | **Paperclip Evolution** |
| Project ID | `6ea59a32-3d6a-4602-81bd-0df63db085a5` |
| Auth header | `X-Api-Key: plane_api_ab9f003cbdcb4be0bfe65fc9a59f5b61` |
| Identifier | PEV |

### Quick API reference

```sh
HDR="X-Api-Key: plane_api_ab9f003cbdcb4be0bfe65fc9a59f5b61"
BASE="http://plane.nexus.local/api/v1/workspaces/nous/projects/6ea59a32-3d6a-4602-81bd-0df63db085a5"

# List all issues
curl -s -H "$HDR" "$BASE/issues/?per_page=100"

# Get single issue
curl -s -H "$HDR" "$BASE/issues/{issue_id}/"

# Update issue state
curl -s -X PATCH -H "$HDR" -H "Content-Type: application/json" \
  -d '{"state": "{state_id}"}' "$BASE/issues/{issue_id}/"

# Add comment to issue
curl -s -X POST -H "$HDR" -H "Content-Type: application/json" \
  -d '{"comment_html": "<p>Your comment</p>"}' "$BASE/issues/{issue_id}/comments/"

# List cycles (sprints)
curl -s -H "$HDR" "$BASE/cycles/"

# List modules (phases)
curl -s -H "$HDR" "$BASE/modules/"

# Create issue
curl -s -X POST -H "$HDR" -H "Content-Type: application/json" \
  -d '{"name": "...", "priority": "high", "state": "{state_id}", "parent": "{epic_id}"}' \
  "$BASE/issues/"

# Add issue to cycle
curl -s -X POST -H "$HDR" -H "Content-Type: application/json" \
  -d '{"issues": ["{issue_id}"]}' "$BASE/cycles/{cycle_id}/cycle-issues/"

# Add issue to module
curl -s -X POST -H "$HDR" -H "Content-Type: application/json" \
  -d '{"issues": ["{issue_id}"]}' "$BASE/modules/{module_id}/module-issues/"
```

### State IDs

| State | ID | Group |
|-------|----|-------|
| Backlog | `20e43ed5-651d-4d21-9800-8591204d5ce3` | backlog |
| Todo | `1bd18247-2025-49d1-830f-873864658341` | unstarted |
| In Progress | `9242f915-72b6-402d-8923-118e8b5d2898` | started |
| Done | `8ac06912-fc0f-4338-92a4-f17fa62dc7f8` | completed |
| Cancelled | `4fc993f5-e834-4649-bd38-7910cc5669da` | cancelled |

### Plane structure

- **Modules** = Phases (Phase 1: Org Structure → Phase 7: Enterprise Auth)
- **Cycles** = Sprints (Sprint 1–12, 2-week cadence)
- **Sub-issues** = EPICs (Phase EPICs) have children (deliverables)
- **Labels** = Feature, Tech Debt, Security, UX/UI, Plugin, Integration, Infrastructure, Documentation, Epic
- **Priority** = urgent / high / medium / low

### Estimate points (story points)

Use modified Fibonacci. Set via `PATCH .../issues/{id}/` with `{"estimate_point": "<uuid>"}`.

| Points | UUID | Use for |
|--------|------|---------|
| 2 | `6bd48d57-980f-4ea6-b494-91648b8df3ae` | Trivial — config change, small fix |
| 3 | `3ff64c42-24a7-44cf-a24c-07ff405cdaae` | Small — single file, well-scoped |
| 5 | `b129a237-ee97-4bfd-8e4f-8f3dea9721a7` | Medium — multi-file, service + route + test |
| 8 | `6c48129a-b23a-416c-904b-5752de4702e8` | Large — cross-cutting, schema + service + route + UI + tests |

Always assign estimate points when creating issues. EPICs don't need points.

### Issue comments — agent communication

Comments are the primary way agents communicate progress and hand off context.

```sh
# Post a comment
curl -s -X POST -H "$HDR" -H "Content-Type: application/json" \
  -d '{"comment_html": "<p>Started work. Key files: server/src/services/sla.ts</p>"}' \
  "$BASE/issues/{issue_id}/comments/"

# Threaded reply
curl -s -X POST -H "$HDR" -H "Content-Type: application/json" \
  -d '{"comment_html": "<p>Reply</p>", "parent": "{parent_comment_id}"}' \
  "$BASE/issues/{issue_id}/comments/"

# Read comments
curl -s -H "$HDR" "$BASE/issues/{issue_id}/comments/"
```

**When to comment:**
- Starting work: what you plan to do, which files you'll touch
- Hitting a blocker: what's blocking, what unblocks it
- Making a design decision: what you chose and why
- Completing work: summary of changes, files modified, test results
- Handing off: context the next agent needs to continue

### Issue links — cross-references

Attach PRs, docs, and external references to issues.

```sh
# Add a link
curl -s -X POST -H "$HDR" -H "Content-Type: application/json" \
  -d '{"title": "PR #42", "url": "https://github.com/owner/repo/pull/42"}' \
  "$BASE/issues/{issue_id}/links/"

# Remove a link
curl -s -X DELETE -H "$HDR" "$BASE/issues/{issue_id}/links/{link_id}/"
```

**Always link:** PRs, relevant doc/plans/ files, deployment URLs, related external issues.

### Issue activities — audit trail

Read-only history of all changes on an issue.

```sh
curl -s -H "$HDR" "$BASE/issues/{issue_id}/activities/"
```

Returns: who changed what field, old/new values, timestamps. Useful for understanding issue history before picking up work.

### Rich issue queries

Use `expand` to get resolved objects instead of UUIDs:

```sh
# Get issues with full state, label, and assignee objects
curl -s -H "$HDR" "$BASE/issues/?per_page=100&expand=state,labels,assignees"
```

### Mandatory workflow for every agent

#### 1. Before starting work

- Fetch current sprint's issues: `GET .../cycles/{cycle_id}/cycle-issues/`
- Read issue description and comments to understand full context
- Check issue activities to see if anyone else has worked on it
- Move the issue to **In Progress**: `PATCH .../issues/{id}/ {"state": "9242f915-..."}`
- Post a comment: what you plan to do

#### 2. During work

- Post progress comments on the issue (every significant milestone or decision)
- If you discover new work, create a new issue in Plane:
  - Assign priority and estimate points
  - Set parent (EPIC), cycle (sprint), and module (phase)
  - Write a self-contained description with acceptance criteria
- If blocked, post a comment explaining what blocks and what unblocks
- If scope changes, update the issue description

#### 3. After completing work

- Run verification: `pnpm -r typecheck && pnpm test:run && pnpm build`
- Post a closing comment with:
  - Summary of what was done
  - Key files changed
  - Test results (pass count)
  - Any follow-up work needed
- Link the PR to the issue (if applicable)
- Move issue to **Done**: `PATCH .../issues/{id}/ {"state": "8ac06912-..."}`
- If all children of an EPIC are Done, close the EPIC too

#### 4. Planning and creating issues

- New work → create issue in Plane **first**, then execute
- Every issue must have:
  - Self-contained description (any agent can pick it up cold)
  - Acceptance criteria (numbered list)
  - Priority (urgent/high/medium/low)
  - Estimate points (2/3/5/8)
  - Cycle (sprint) and module (phase) assignment
  - Parent EPIC (if applicable)
  - Labels
  - Start and target dates
- Reference `doc/plans/` files from descriptions for deep technical context
- EPICs should describe the goal, scope, and acceptance criteria for the entire phase

## 1. Purpose

Paperclip is a control plane for AI-agent companies.
The current implementation target is V1 and is defined in `doc/SPEC-implementation.md`.

## 2. Read This First

Before making changes, read in this order:

1. `doc/GOAL.md`
2. `doc/PRODUCT.md`
3. `doc/SPEC-implementation.md`
4. `doc/DEVELOPING.md`
5. `doc/DATABASE.md`

`doc/SPEC.md` is long-horizon product context.
`doc/SPEC-implementation.md` is the concrete V1 build contract.

## 3. Repo Map

- `server/`: Express REST API and orchestration services
- `ui/`: React + Vite board UI
- `packages/db/`: Drizzle schema, migrations, DB clients
- `packages/shared/`: shared types, constants, validators, API path constants
- `packages/adapters/`: agent adapter implementations (Claude, Codex, Cursor, etc.)
- `packages/adapter-utils/`: shared adapter utilities
- `packages/plugins/`: plugin system packages
- `doc/`: operational and product docs

## 4. Dev Setup (Auto DB)

Use embedded PGlite in dev by leaving `DATABASE_URL` unset.

```sh
pnpm install
pnpm dev
```

This starts:

- API: `http://localhost:3100`
- UI: `http://localhost:3100` (served by API server in dev middleware mode)

Quick checks:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

Reset local dev DB:

```sh
rm -rf data/pglite
pnpm dev
```

## 5. Core Engineering Rules

1. Keep changes company-scoped.
Every domain entity should be scoped to a company and company boundaries must be enforced in routes/services.

2. Keep contracts synchronized.
If you change schema/API behavior, update all impacted layers:
- `packages/db` schema and exports
- `packages/shared` types/constants/validators
- `server` routes/services
- `ui` API clients and pages

3. Preserve control-plane invariants.
- Single-assignee task model
- Atomic issue checkout semantics
- Approval gates for governed actions
- Budget hard-stop auto-pause behavior
- Activity logging for mutating actions

4. Do not replace strategic docs wholesale unless asked.
Prefer additive updates. Keep `doc/SPEC.md` and `doc/SPEC-implementation.md` aligned.

5. Keep plan docs dated and centralized.
New plan documents belong in `doc/plans/` and should use `YYYY-MM-DD-slug.md` filenames.

## 6. Database Change Workflow

When changing data model:

1. Edit `packages/db/src/schema/*.ts`
2. Ensure new tables are exported from `packages/db/src/schema/index.ts`
3. Generate migration:

```sh
pnpm db:generate
```

4. Validate compile:

```sh
pnpm -r typecheck
```

Notes:
- `packages/db/drizzle.config.ts` reads compiled schema from `dist/schema/*.js`
- `pnpm db:generate` compiles `packages/db` first

## 7. Verification Before Hand-off

Run this full check before claiming done:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

If anything cannot be run, explicitly report what was not run and why.

## 8. API and Auth Expectations

- Base path: `/api`
- Board access is treated as full-control operator context
- Agent access uses bearer API keys (`agent_api_keys`), hashed at rest
- Agent keys must not access other companies

When adding endpoints:

- apply company access checks
- enforce actor permissions (board vs agent)
- write activity log entries for mutations
- return consistent HTTP errors (`400/401/403/404/409/422/500`)

## 9. UI Expectations

- Keep routes and nav aligned with available API surface
- Use company selection context for company-scoped pages
- Surface failures clearly; do not silently ignore API errors

## 10. Pull Request Requirements

When creating a pull request (via `gh pr create` or any other method), you **must** read and fill in every section of [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md). Do not craft ad-hoc PR bodies — use the template as the structure for your PR description. Required sections:

- **Thinking Path** — trace reasoning from project context to this change (see `CONTRIBUTING.md` for examples)
- **What Changed** — bullet list of concrete changes
- **Verification** — how a reviewer can confirm it works
- **Risks** — what could go wrong
- **Model Used** — the AI model that produced or assisted with the change (provider, exact model ID, context window, capabilities). Write "None — human-authored" if no AI was used.
- **Checklist** — all items checked

## 11. Definition of Done

A change is done when all are true:

1. Behavior matches `doc/SPEC-implementation.md`
2. Typecheck, tests, and build pass
3. Contracts are synced across db/shared/server/ui
4. Docs updated when behavior or commands change
5. PR description follows the [PR template](.github/PULL_REQUEST_TEMPLATE.md) with all sections filled in (including Model Used)

## 11. Fork-Specific: HenkDz/paperclip

This is a fork of `paperclipai/paperclip` with QoL patches and an **external-only** Hermes adapter story on branch `feat/externalize-hermes-adapter` ([tree](https://github.com/HenkDz/paperclip/tree/feat/externalize-hermes-adapter)).

### Branch Strategy

- `feat/externalize-hermes-adapter` → core has **no** `hermes-paperclip-adapter` dependency and **no** built-in `hermes_local` registration. Install Hermes via the Adapter Plugin manager (`@henkey/hermes-paperclip-adapter` or a `file:` path).
- Older fork branches may still document built-in Hermes; treat this file as authoritative for the externalize branch.

### Hermes (plugin only)

- Register through **Board → Adapter manager** (same as Droid). Type remains `hermes_local` once the package is loaded.
- UI uses generic **config-schema** + **ui-parser.js** from the package — no Hermes imports in `server/` or `ui/` source.
- Optional: `file:` entry in `~/.paperclip/adapter-plugins.json` for local dev of the adapter repo.

### Local Dev

- Fork runs on port 3101+ (auto-detects if 3100 is taken by upstream instance)
- `npx vite build` hangs on NTFS — use `node node_modules/vite/bin/vite.js build` instead
- Server startup from NTFS takes 30-60s — don't assume failure immediately
- Kill ALL paperclip processes before starting: `pkill -f "paperclip"; pkill -f "tsx.*index.ts"`
- Vite cache survives `rm -rf dist` — delete both: `rm -rf ui/dist ui/node_modules/.vite`

### Fork QoL Patches (not in upstream)

These are local modifications in the fork's UI. If re-copying source, these must be re-applied:

1. **stderr_group** — amber accordion for MCP init noise in `RunTranscriptView.tsx`
2. **tool_group** — accordion for consecutive non-terminal tools (write, read, search, browser)
3. **Dashboard excerpt** — `LatestRunCard` strips markdown, shows first 3 lines/280 chars

### Plugin System

PR #2218 (`feat/external-adapter-phase1`) adds external adapter support. See root `AGENTS.md` for full details.

- Adapters can be loaded as external plugins via `~/.paperclip/adapter-plugins.json`
- The plugin-loader should have ZERO hardcoded adapter imports — pure dynamic loading
- `createServerAdapter()` must include ALL optional fields (especially `detectModel`)
- Built-in UI adapters can shadow external plugin parsers — remove built-in when fully externalizing
- Reference external adapters: Hermes (`@henkey/hermes-paperclip-adapter` or `file:`) and Droid (npm)
