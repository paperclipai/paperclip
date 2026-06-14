# Gate-Team Auto-Provision — Catalog Port + defaultInstall (shipped) Overview

> Written 2026-06-15. Covers the auto-provisioning follow-up: a fresh company now
> comes up gate-ready with no manual `install.py`. Commits: `8c8bff53` (catalog),
> `25b1e85b` (server hook). Plan: `~/docs/plans` (archived after this).

---

## Background

This session made dev-team gates real (identity seed #4, backfill, W5a/W5b wakes,
burn guards). But the gate squad still had to be hand-provisioned per company by
running operator-local `.agents/dev-team/install.py`. Recon found:

- The **teams-catalog** install path already materializes a team's agents + skills
  with org tree + collision handling (`teamsCatalogService.installCatalogTeam`).
- The **`defaultInstall`** flag existed on `core-exec-team` but was **dead** — nothing
  consumed it.
- **No catalog team had the gate squad** — only `.agents/dev-team` did.

## What shipped

### 1. dev-team is now a checked-in catalog team (`8c8bff53`)
`packages/teams-catalog/catalog/bundled/software-development/dev-team/`:
- `TEAM.md` — CTO as `manager`/root, the 5 other agents + 7 skills in `includes`,
  `defaultInstall: true`.
- 6 agent `AGENTS.md` (cto/architect/code-reviewer/wiring-expert/implementor-1/-2)
  with frontmatter (`role`, `model`, `reportsTo: cto`, `skills`) + the role identity
  bodies. Roles use the canonical `cto`/`engineer`/`qa` vocabulary.
- The 7 eco-system skills **vendored in-package** under `skills/` (slug = dir name):
  code-review, context-engineering, debugging-and-error-recovery,
  incremental-implementation, source-driven-development, dev-roles, task-timing. The
  4 bundled `paperclip*` skills are not in the catalog and not local — they are
  `required:true` bundled skills auto-merged at runtime, so they are omitted from
  agent frontmatter (listing them would fail manifest skill-resolution).
- Manifest rebuilt (`build:manifest`); `generated/catalog.json` ships dev-team with
  6 agents, 7 resolved local skills, root `cto`, `trustLevel: markdown_only`.
- `core-exec-team` flipped to `defaultInstall: false` so a fresh company gets the
  gate squad, not a duplicate CTO/QA. core-exec stays manually installable.

### 2. company-create installs defaultInstall teams (`25b1e85b`)
`routes/companies.ts` POST `/`, after the budget hooks: enumerate
`listCatalogTeams().filter(defaultInstall)` and `installCatalogTeam(company.id,
team.key, { collisionStrategy: "skip", actor })` for each not already installed.
- **Non-fatal** (`try/catch` + `logger.warn`) — provisioning never fails company
  creation.
- **Idempotent** via `listInstalledCatalogTeams`.
- Install routes through the **portability importer (agent_safe)**, which bypasses
  `requireBoardApprovalForNewAgents`.

## Flow

```
POST /api/companies  (board actor)
  → company created (+ membership, budgets)
  → defaultTeams = listCatalogTeams().filter(t => t.defaultInstall)        // [dev-team]
  → for each not in listInstalledCatalogTeams(company.id):
        teamsCatalog.installCatalogTeam(company.id, team.key,
          { collisionStrategy: "skip", actor })
          → portability import → CTO (root) + Architect + Code Reviewer +
            Wiring Expert + Implementor 1/2, skills assigned, identities set
  → logActivity "company.auto_provisioned"
  → 201 (provisioning failure logged, never fatal)
```

## Why the agent identity is correct here

Catalog install sets each agent's instruction bundle from the package `AGENTS.md`
directly, so the gate identity comes from the catalog content. The #4
onboarding-assets seed remains the fallback for non-catalog single-agent creates.

## Verification

- `packages/teams-catalog` suite (11): manifest team keys + dev-team shape + sole
  defaultInstall.
- `teams-catalog-install-no-overrides` (embedded-pg): dev-team install → 6 agents,
  CTO root, all others report to CTO.
- `company-auto-provision-routes` (mocked): create installs only dev-team,
  idempotent, non-fatal on error.
- Regression: refreshed the pinned `core-exec` contentHash; teams-catalog +
  companies suites green; `tsc` clean. No DB migration.

## Companion non-build items (operator)

- **#13 tmpfs** — before a pilot, export `CLAUDE_CODE_TMPDIR` to a roomy dir so a
  full `/tmp` can't break CLI output capture. Env only, no code.
- **Backfill existing company** — if reusing the current company (agents created
  before #4), run `server/scripts/backfill-gate-instructions.ts` (dry then
  `--apply`) to bring already-created gate agents to current identity. New companies
  need nothing — they auto-provision gate-ready.
- **#11 CTO self-assign** — eco-system prompt (`teams/agent-team/prompts`), out of
  this repo.

## Caveat — fork divergence

Vendoring the 7 eco-system skills into the catalog widens divergence from upstream
Paperclip. Accepted for a self-contained, installable gate team. The skill dirs are
self-contained under the team package to keep the merge surface localized.
