# AGENTS.md

Guidance for human and AI contributors working in this repository.

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
- `packages/skills-catalog/`: app-shipped skills catalog (`@paperclipai/skills-catalog`)
- `packages/teams-catalog/`: app-shipped teams catalog (`@paperclipai/teams-catalog`)
- `cli/`: `paperclipai` CLI package (published bin, agent-facing commands)
- `skills/`: Paperclip runtime/operational skills (not part of the app catalog)
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

## 5. Agent Roster

This section documents the agent workforce in the **Praxis M&A (GStack)** company.

| # | Agent | Title | Role | Reports To | Target Budget/mo | Target Budget/yr | API Budget/mo | Status | Permissions |
|---|-------|-------|------|------------|-----------------|-----------------|---------------|--------|-------------|
|| 1 | **CEO** | Chief Executive Officer | agent | — (top) | $0 (governance) | $0 | $2,000 | running | assignTasks, createAgents, createSkills |
|| 2 | **CTO** | Chief Technology Officer | agent | CEO | $1,000 | $12,000 | $1,000 | running | createSkills |
|| 3 | **Staff Engineer** | Staff Engineer | agent | CEO | $300 | $3,600 | $300 | idle | createSkills |
|| 4 | **Release Engineer** | Release Engineer | agent | CEO | $200 | $2,400 | $200 | running | createSkills |
|| 5 | **QA Engineer** | QA Engineer | agent | CEO | $500 | $6,000 | $500 | idle | createSkills |
|| 6 | **CSO** | Chief Security Officer | agent | CTO | $500 | $6,000 | $500 | idle | assignTasks, createAgents, createSkills |
|| 7 | **Design Agent** | UX/UI Designer | designer | CTO | $300 | $3,600 | $300 | idle | assignTasks, createSkills |

> **Notes**: 
> - The "API Budget/mo" column reflects live values from `GET /api/companies/{companyId}/agents`. Report-to (managerAgentId) is still `null` in the database — the hierarchy above is the intended org structure.
> - The **Release Engineer** serves as the Ship Agent role, covering `ship` and `land-and-deploy` skills. No separate Ship Agent identity is needed.
> - The **CSO** role was previously `general` and has been corrected to `agent` (PRX-31/PRX-67).

### Reporting Hierarchy

```
CEO (running)
├── CTO (running)
│   ├── CSO (idle)
│   └── Design Agent (idle)
├── Staff Engineer (idle)
├── Release Engineer (running)
└── QA Engineer (idle)
```

### Skill Wiring Status (Phase 2 Complete — 2026-08-22)

All 7 agents are now wired with their assigned GStack skills via `POST /api/agents/{id}/skills/sync`. All skills use the `garrytan/gstack/` key prefix.

| Agent | Skills Configured |
|-------|-------------------|
| **CEO** | office-hours, plan-ceo-review, context-save, context-restore |
| **CTO** | plan-eng-review, spec, investigate, context-save, context-restore |
| **CSO** | qa, investigate, context-save, context-restore |
| **Design Agent** | design-consultation, design-review, design-html, context-save, context-restore |
| **QA Engineer** | qa, qa-only, review, context-save, context-restore |
| **Release Engineer** | ship, land-and-deploy, context-save, context-restore |
| **Staff Engineer** | investigate, spec, context-save, context-restore |

The `context-save` and `context-restore` skills are now imported at the company level and configured for all 7 agents. Child issues PRX-57 through PRX-62 are all marked `done`. See the company's `/api/companies/{companyId}/skills` endpoint for the full catalog.

### Phase 1 Status

**v0.5.0 Phase 1** — delivered 2026-08-19. Scope: Server boot fixes, integration wiring, notification delivery, marketplace auth, billing trust, H-series hotfixes, PostHog pre-stage instrumentation, knowledge starter packs API, and docs site (case studies, quickstart, Discord community). See `doc/retro/2026-08-19-engineering-retrospective.md` for the full retrospective.

### Adapter Configuration

All 7 agents use adapter type `hermes_local` (Hermes Agent local process adapter). No non-default adapter configs or runtime configs are set. No default environments are assigned.

### Budget Summary

> **Note**: "Target" figures are planned aspirational allocations from the PRX-1 plan. "API" figures are live values from `GET /api/companies/{companyId}/agents`. Both are soft limits — not system-enforced caps today.

| Metric | Target Amount | API Amount |
|--------|-------------|-----------|
| Total monthly target budget | $2,800 | $4,800 |
| Total yearly target budget | $33,600 | $57,600 |
| Company-level budget | $0 (unlimited) | $0 (unlimited) |
| Spent to date (current month) | $0 | $0 |

## 6. Board Directive — VOY-1668: Hard Stop Paperclip Feature Development

**Effective**: 2026-08-22 ~05:00 UTC

**Directive**: All Paperclip platform feature development is stopped. Engineering resources shift from platform-building to Voyonder product delivery.

### What is STOPPED

- New Paperclip features (routes, services, UI pages, platform capabilities)
- Paperclip platform enhancements not directly supporting Voyonder customers

### What CONTINUES

- P0/P1 production bug fixes in Paperclip
- Security patches
- Customer-blocking fixes
- Voyonder product development (primary focus)
- Customer acquisition and onboarding (VOY-1586)
- Billing pipeline reliability fixes (in-progress P1/P2)
- Infrastructure operations, monitoring, uptime

### New Priority Stack

1. P0/P1 Voyonder production issues
2. Customer acquisition and onboarding
3. Billing pipeline reliability
4. Paperclip P0/P1 security and bug fixes
5. Everything else — STOPPED

### Voyonder Repository

- URL: https://github.com/PraeSynBH/voyonder
- Visibility: Private

See `doc/status/2026-08-22-coo-board-directive-voy-1668.md` for the full directive document.

## 7. Core Engineering Rules

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

5. Keep repo plan docs dated and centralized.
When you are creating a plan file in the repository itself, new plan documents belong in `doc/plans/` and should use `YYYY-MM-DD-slug.md` filenames. This does not replace Paperclip issue planning: if a Paperclip issue asks for a plan, update the issue `plan` document per the `paperclip` skill instead of creating a repo markdown file.

6. Attach inspectable generated artifacts.
When your task produces a user-inspectable deliverable file, follow the Paperclip skill's "Generated Artifacts and Work Products" workflow before final disposition. In this repo, prefer the self-contained skill helper at `skills/paperclip/scripts/paperclip-upload-artifact.sh` so the file is available through the Paperclip API, create/update an artifact work product when the file is the deliverable, link the uploaded artifact in the final issue comment, and then set status. Do not rely on local filesystem paths as the only access path. If an important file intentionally remains workspace-only, create/update a work product with `metadata.resourceRef.kind: "workspace_file"` and a workspace-relative path, then name that work product and path in the final comment. Treat browse/search as a fallback for recovering workspace files, not the preferred deliverable path. See `doc/AGENT-ARTIFACTS.md` for details and `.mp4`/`.webm` examples.

## 8. Database Change Workflow

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

## 9. Verification Before Hand-off

Default local/agent test path:

```sh
pnpm test
```

This is the cheap default and only runs the Vitest suite. Browser suites stay opt-in:

```sh
pnpm test:e2e
pnpm test:release-smoke
```

Run the browser suites only when your change touches them or when you are explicitly verifying CI/release flows.

For normal issue work, run the smallest relevant verification first. Do not default to repo-wide typecheck/build/test on every heartbeat when a narrower check is enough to prove the change.

Run this full check before claiming repo work done in a PR-ready hand-off, or when the change scope is broad enough that targeted checks are not sufficient:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

If anything cannot be run, explicitly report what was not run and why.

## 10. API and Auth Expectations

- Base path: `/api`
- Board access is treated as full-control operator context
- Agent access uses bearer API keys (`agent_api_keys`), hashed at rest
- Agent keys must not access other companies

When adding endpoints:

- apply company access checks
- enforce actor permissions (board vs agent)
- write activity log entries for mutations
- return consistent HTTP errors (`400/401/403/404/409/422/500`)

## 11. UI Expectations

- Keep routes and nav aligned with available API surface
- Use company selection context for company-scoped pages
- Surface failures clearly; do not silently ignore API errors

## 12. Pull Request Requirements

When creating a pull request (via `gh pr create` or any other method), you **must** read and fill in every section of [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md). Do not craft ad-hoc PR bodies — use the template as the structure for your PR description. Required sections:

- **Thinking Path** — trace reasoning from project context to this change (see `CONTRIBUTING.md` for examples)
- **What Changed** — bullet list of concrete changes
- **Verification** — how a reviewer can confirm it works
- **Risks** — what could go wrong
- **Model Used** — the AI model that produced or assisted with the change (provider, exact model ID, context window, capabilities). Write "None — human-authored" if no AI was used.
- **Checklist** — all items checked

## 13. Definition of Done

A change is done when all are true:

1. Behavior matches `doc/SPEC-implementation.md`
2. Typecheck, tests, and build pass
3. Contracts are synced across db/shared/server/ui
4. Docs updated when behavior or commands change
5. PR description follows the [PR template](.github/PULL_REQUEST_TEMPLATE.md) with all sections filled in (including Model Used)

## Design system

`DESIGN.md` at the repo root is the source of truth for UI design decisions. The token-only rule applies to all `ui/` changes: every color, spacing, radius, type, shadow, and motion value in `ui/src/components/**` and `ui/src/pages/**` comes from the token layer in `ui/src/index.css` — no hex, raw px, arbitrary Tailwind bracket values, or raw `font-size`/`fontSize` declarations in components, outside the documented allowlist in `ui/src/index.css`. Run `pnpm check:token-gates` (`scripts/check-token-gates.mjs`) before committing UI changes — it fails on any violation not covered by that allowlist.
