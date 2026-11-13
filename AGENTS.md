# AGENTS.md

Guidance for human and AI contributors working in this repository.

This codebase is yours: what it's for and how it's built are your call, and you'll keep building on it.
The invariants and rules below record what has been decided so far. If you think one of them is wrong, say so and propose the change; do not work around it.

## 1. Purpose

Paperclip is a control plane for AI-agent companies.
The code and its tests are the source of truth for current behavior.
The focused docs under `doc/` are background. They can be out of date, so do not treat them as requirements when they disagree with the code or with the task.

## 2. Read This First

Read the doc that matches your change before you start:

| Your change touches | Read |
| --- | --- |
| Product behavior or scope | `doc/GOAL.md`, `doc/PRODUCT.md` |
| Setup, commands, testing, worktrees | `doc/DEVELOPING.md` |
| Schema, migrations, DB clients | `doc/DATABASE.md` |
| An Apps catalog connection | `doc/connections/CONNECTOR-PLAYBOOK.md` (the canonical connection authoring runbook) |
| Anything under `ui/` | `DESIGN.md` |

### Scoped repository rules

`rules/*.mdc` holds the architecture rules that reviewers apply to a pull
request. Each file starts with a short header: `description` is a one-sentence
summary of the rule, `globs` lists the files it covers, and `alwaysApply: true`
means it covers the whole repository.

You do not need to read the rule bodies before every change. List the headers to
see which rules exist and what each one asks for:

```sh
grep -E '^(description|globs|alwaysApply):' rules/*.mdc
```

Write the change so that it satisfies the descriptions of the rules that cover
your files. Read the full body of a rule only in these cases:

- You are making a design decision in the area the rule covers, such as adding a
  module, a background worker, or persisted state.
- The description does not tell you whether your change complies.
- A reviewer cites the rule.

These rules supplement this file and any applicable nested `AGENTS.md`
instructions. See [`rules/README.md`](rules/README.md) for rule authoring and
Greptile setup.

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
- `doc/plans/`: dated repo plan docs, named `YYYY-MM-DD-slug.md`. A plan for a Paperclip issue goes in the issue's `plan` document instead.
- `rules/`: scoped repository rules (see section 2)

## 4. Dev Setup

```sh
node scripts/agent-preflight.mjs   # prepare a new or updated worktree
pnpm dev                           # API and UI at http://localhost:3100
```

Leave `DATABASE_URL` unset to use the embedded database. See "Agent worktree
preflight", "Start Dev", "Quick Health Checks", and "Database in Dev" in
`doc/DEVELOPING.md`.

## 5. Core Engineering Rules

1. **Keep changes company-scoped.**
   Every domain entity should be scoped to a company and company boundaries must be enforced in routes/services. The few instance-wide exceptions are listed in [`rules/company-scope-exceptions.mdc`](rules/company-scope-exceptions.mdc). Do not add another without adding it to that list.

2. **Keep contracts synchronized.**
   If you change schema/API behavior, update all impacted layers:
   - `packages/db` schema and exports
   - `packages/shared` types/constants/validators
   - `server` routes/services
   - `ui` API clients and pages

3. **Preserve control-plane invariants.**
   - Single-assignee task model
   - Atomic issue checkout semantics
   - Approval gates for governed actions
   - Budget hard-stop auto-pause behavior
   - Activity logging for mutating actions

4. **Keep behavior with its owning module.**
   Provider protocols, payload parsing, and feature-specific sequencing belong to the module that owns them. Shared code uses narrow, normalized contracts. Explain any substantive change outside the owning module. See [`rules/module-boundaries.mdc`](rules/module-boundaries.mdc).

## 6. Database Changes

Follow "Schema change workflow" in `doc/DATABASE.md`: edit the schema, run
`pnpm db:generate`, then typecheck.

## 7. Verification Before Hand-off

Run the smallest check that proves the change. The default local and agent path is:

```sh
pnpm verify
```

This selects affected Vitest files with the same conservative dependency policy
as CI. It includes committed, staged, unstaged, and untracked changes against the
merge base with local `origin/master` (or `master`), and it reuses passing checks
whose inputs are unchanged. Use `--base <ref>` for another base, `--explain` to
inspect the selection, and `--no-cache` for fresh execution. See "Incremental
local verification" in `doc/DEVELOPING.md` for how reuse and invalidation work.

Follow these rules:

- **Exit 2 means the change needs broader verification.** Run focused checks and
  let required CI supply that coverage, or explicitly use `pnpm verify --full`
  for the full local Vitest suite. Do not automatically follow exit 2 with a full
  local run.
- **Do not default to repo-wide checks.** Do not run repo-wide typecheck, build,
  or test on every heartbeat when a narrower check is enough to prove the change.
  Use the broad checks below only when they resolve an actual remaining gap, such
  as a local platform fault or explicit full-suite qualification.
- **Browser suites stay opt-in.** Run `pnpm test:e2e` and
  `pnpm test:release-smoke` only when your change touches them or when you are
  explicitly verifying CI/release flows.
- **CI covers the final revision.** For a PR-ready handoff, run the relevant local
  checks and require the applicable CI typecheck, build, and test checks to pass
  for the final tested revision. Record their scope, revision, environment, and
  result links. Fresh CI can supply broad coverage; do not duplicate a full local
  run merely to prepare a PR, resume a chat, or repeat unchanged passing
  verification. A selected local pass does not replace required CI, release
  qualification, browser acceptance, or a local/platform-specific regression.
- **Evidence expires.** After edits or a rebase, rerun affected checks and
  invalidate evidence whose inputs or required coverage changed. Failed or
  interrupted attempts are never passes.
- **Report gaps.** If anything cannot be run, explicitly report what was not run
  and why.
- **Attach deliverables.** When you work a Paperclip issue and produce a file for
  the user to inspect, attach it as the `paperclip` skill and
  `doc/AGENT-ARTIFACTS.md` describe. A local filesystem path is not enough.

Broad local checks:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

`pnpm test` and `pnpm test:run` run the full suite. If memory is limited, use
`node scripts/typecheck-low-memory.mjs` instead of `pnpm -r typecheck`. See
`doc/DEVELOPING.md`.

### Maps and Storybook

The [feature map](maps/feature-map/README.md) and the sibling
[agent access map](maps/agent-access-map/README.md) are optional references for
user entry points, agent entry points, permission boundaries, verification
recipes, and coverage gaps. They record coverage scope, not proof that a live
journey passed. Routine fixes, polish, refactors, and test changes do not require
map updates. When you do edit a map, follow
[the feature-map scope rule](rules/feature-map-scope.mdc) and
[the map contract](maps/README.md), then run `node scripts/check-maps.mjs`.

After story or recipe changes, update the affected source annotations or recipe
and run `node scripts/storybook-catalog.mjs`. Indexes are generated and ignored;
never commit them. See the [Storybook feature catalog](maps/storybook-map/README.md)
for the full workflow. Structural checks are not production acceptance.

## 8. API and Auth

Every route under `server/src/routes/` that reads or writes company data checks
company access and actor permissions, logs mutations to the activity log, and
returns consistent HTTP errors. See [`rules/api-route-expectations.mdc`](rules/api-route-expectations.mdc).

## 9. UI Expectations

- Keep routes and nav aligned with available API surface
- Use company selection context for company-scoped pages
- Surface failures clearly; do not silently ignore API errors
- Follow `DESIGN.md` for every UI design decision, including the token-only rule and form footers.

## 10. Fixing a Bug

When you are asked to fix a bug, attempt to use test-driven development and prove the fix red-green:

1. Reproduce the error yourself.
2. Write a test that fails because of the bug.
3. Write the fix.
4. Run the test and confirm that it passes.
5. Verify that the fix worked: repeat the reproduction from step 1 and confirm that the error is gone.

## 11. Pull Requests

Fill in every section of [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md), however you create the pull request. Do not write an ad-hoc body. See "PR Requirements" in `CONTRIBUTING.md` for the details and thinking-path examples.

## 12. Definition of Done

A change is done when all are true:

1. Behavior matches what the task asked for and preserves the invariants in section 5
2. Relevant local verification and required CI typecheck, test, and build checks pass for the final revision, with any acceptance or platform-specific gaps resolved (section 7)
3. Contracts are synced across db/shared/server/ui
4. Docs updated when behavior or commands change
5. PR description follows the [PR template](.github/PULL_REQUEST_TEMPLATE.md) with all sections filled in (including Model Used)
