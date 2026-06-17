# AGENTS.md

Guidance for human and AI contributors working in this repository.

## 1. Purpose

Paperclip is a control plane for AI-agent companies.

This repository contains the Paperclip app, server, shared packages, adapters,
database schema, documentation, and local agent skill definitions.

## 2. Read This First

Before making code or operational changes, read in this order:

1. `README.md`
2. `doc/GOAL.md`
3. `doc/PRODUCT.md`
4. `doc/SPEC-implementation.md`
5. `doc/DEVELOPING.md`
6. `doc/DATABASE.md`

If a requested change concerns an agent skill, also read the relevant
`.agents/skills/<skill-name>/SKILL.md` file and any files under that skill's
`references/` directory.

## 3. Repo Map

- `server/`: Express REST API and orchestration services
- `ui/`: React + Vite board UI
- `packages/db/`: Drizzle schema, migrations, and DB clients
- `packages/shared/`: shared types, constants, validators, and API path constants
- `packages/adapters/`: agent adapter implementations
- `packages/adapter-utils/`: shared adapter utilities
- `packages/plugins/`: plugin system packages
- `doc/`: product, implementation, development, and operational docs
- `.agents/skills/`: local agent skill packages

## 4. Dev Setup

Use embedded PGlite in local development by leaving `DATABASE_URL` unset unless
the task explicitly requires another database mode.

```bash
pnpm install
pnpm dev
```

Default local endpoints:

- API: `http://localhost:3100`
- UI: `http://localhost:3100`

Quick checks:

```bash
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

Reset local dev DB:

```bash
rm -rf data/pglite
pnpm dev
```

## 5. Core Rules

1. Keep changes company-scoped.
2. Keep DB, shared types, API routes, services, and UI clients synchronized.
3. Preserve the single-assignee task model.
4. Preserve atomic issue checkout semantics.
5. Preserve approval gates for governed actions.
6. Preserve budget hard-stop and auto-pause behavior.
7. Write activity log entries for mutating actions.
8. Do not replace strategic docs wholesale unless explicitly asked.
9. Prefer additive, minimal changes that match existing style.
10. If unsure whether a destructive action is safe, skip it and report.

## 6. Agent Skill Rules

Agent skills live under:

```text
.agents/skills/<skill-name>/SKILL.md
```

A skill may include supporting files under:

```text
.agents/skills/<skill-name>/references/
```

Each `SKILL.md` should include YAML frontmatter:

```markdown
***
name: skill-name
description: >
  Short description of when and how to use the skill.
***
```

Skill changes should be small, reviewable, and operationally safe. If a skill
can delete files, mutate data, or trigger external side effects, it must include
clear safety rules, dry-run behavior, and reporting requirements.

## 7. Janitor Skill

The Janitor skill lives at:

```text
.agents/skills/janitor/SKILL.md
```

Its purpose is daily overnight operational hygiene.

Default routine:

- Cadence: daily
- Window: 02:00-03:00 server-local time
- Preferred start: 02:15 server-local time
- Source: `timer`
- Trigger: `callback`

Before changing or running Janitor, read:

1. `.agents/skills/janitor/SKILL.md`
2. `.agents/skills/janitor/references/pruning-policy.md`
3. `.agents/skills/janitor/references/dry-run-checklist.md`
4. `.agents/skills/janitor/references/anomaly-rules.md`
5. `.agents/skills/janitor/references/nightly-routine.md`
6. `.agents/skills/janitor/references/report-template.md`

Janitor must never delete:

- Agent records
- Company records
- Projects
- Issues
- Approvals
- Documents
- Comments
- Activity logs
- Active or pending heartbeat runs
- Database files or WAL files directly

Janitor must always dry-run first, prune only allowlisted artifacts, and report
what was cleaned, skipped, and escalated.

## 8. Database Changes

When changing the data model:

1. Edit `packages/db/src/schema/*.ts`
2. Export new tables from `packages/db/src/schema/index.ts`
3. Generate a migration:

```bash
pnpm db:generate
```

4. Validate compile:

```bash
pnpm -r typecheck
```

If schema/API behavior changes, update shared validators, server routes/services,
UI clients, and docs in the same change.

## 9. Verification

For normal work, run the smallest relevant verification first.

Default cheap check:

```bash
pnpm test
```

Before handing off broad or PR-ready repo work, run:

```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```

Browser suites are opt-in unless the change touches them:

```bash
pnpm test:e2e
pnpm test:release-smoke
```

If a check cannot be run, state what was not run and why.

## 10. API and Auth

- Base API path: `/api`
- Board access is full-control operator context
- Agent access uses bearer API keys
- Agent API keys must be hashed at rest
- Agent API keys must not cross company boundaries

When adding endpoints:

- Enforce company access checks
- Enforce actor permissions
- Write activity log entries for mutations
- Return consistent HTTP errors: `400`, `401`, `403`, `404`, `409`, `422`, `500`

## 11. Pull Requests

When creating a pull request, use `.github/PULL_REQUEST_TEMPLATE.md`.

Fill in every required section:

- Thinking Path
- What Changed
- Verification
- Risks
- Model Used
- Checklist

Do not use ad-hoc PR bodies.

## 12. Definition of Done

A change is done when all are true:

1. Behavior matches `doc/SPEC-implementation.md`
2. Relevant tests pass
3. Typecheck/build pass when scope requires them
4. DB/shared/server/UI contracts are synchronized
5. Docs are updated when behavior or commands change
6. PR description follows the template
7. Any operational skill change includes safety, reporting, and rollback guidance
