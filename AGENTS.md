# AGENTS.md

Guidance for human and AI contributors working in this repository.

This codebase is yours: what it's for and how it's built are your call, and you'll keep building on it.
The invariants and rules below record what has been decided so far. If you think one of them is wrong, say so and propose the change; do not work around it.

## 1. Purpose

Paperclip is a control plane for AI-agent companies.
The code and its tests are the source of truth for current behavior.
`doc/SPEC-implementation.md` and `doc/SPEC.md` are background. They can be out of date, so do not treat them as requirements when they disagree with the code or with the task.

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
- `rules/`: scoped repository rules (see section 2)

## 4. Dev Setup (Auto DB)

Prepare a new or updated worktree with one command:

```sh
node scripts/agent-preflight.mjs
```

Use it instead of running `pnpm install`, the Runner build, and `build:rust` by
hand. It skips unchanged steps and reuses other worktrees' builds from a
content-keyed cache in `~/.cache/paperclip/agent-build`. Do not share
`CARGO_TARGET_DIR` between worktrees. See "Agent worktree preflight" in
`doc/DEVELOPING.md`.

Start the app. Leave `DATABASE_URL` unset to use embedded PGlite:

```sh
pnpm dev
```

This serves the API and the UI at `http://localhost:3100` (the API server serves
the UI in dev middleware mode).

Quick checks:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

Reset the local dev DB. This deletes all local dev data:

```sh
rm -rf data/pglite
pnpm dev
```

## 5. Core Engineering Rules

1. Keep changes company-scoped.
Every domain entity should be scoped to a company and company boundaries must be enforced in routes/services.

Explicit exception: announcement dismissals are instance-wide user preferences,
keyed by user and announcement so they persist across companies. Their audit
context must still validate company membership. The announcement publication-ID
registry is instance-level feed metadata; it contains no company or user data.
Personal workspace presentation preferences are also instance-wide by user, with
validated company membership supplying audit context. They never grant execution
authority, change company capabilities or agent configuration, or rewrite canonical
work records. Optional conversation guidance must retain the same action permissions.

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
Prefer additive updates.

5. Keep repo plan docs dated and centralized.
When you are creating a plan file in the repository itself, new plan documents belong in `doc/plans/` and should use `YYYY-MM-DD-slug.md` filenames. This does not replace Paperclip issue planning: if a Paperclip issue asks for a plan, update the issue `plan` document per the `paperclip` skill instead of creating a repo markdown file.

6. Attach inspectable generated artifacts.
When your task produces a user-inspectable deliverable file, follow the Paperclip skill's "Generated Artifacts and Work Products" workflow before final disposition. In this repo, prefer the self-contained skill helper at `skills/paperclip/scripts/paperclip-upload-artifact.sh` so the file is available through the Paperclip API, create/update an artifact work product when the file is the deliverable, link the uploaded artifact in the final issue comment, and then set status. Do not rely on local filesystem paths as the only access path. If an important file intentionally remains workspace-only, create/update a work product with `metadata.resourceRef.kind: "workspace_file"` and a workspace-relative path, then name that work product and path in the final comment. Treat browse/search as a fallback for recovering workspace files, not the preferred deliverable path. See `doc/AGENT-ARTIFACTS.md` for details and `.mp4`/`.webm` examples.

7. Name the three data paths correctly.
This repo has three separate data paths. Do not confuse them. Match a change to a path by its file path, not by the word "observability" or "telemetry" alone.

- **Telemetry** is the Paperclip first-party event system under `packages/shared/src/telemetry/`. It sends data to a Paperclip endpoint by default, so a change needs strict review: generated contract first, README update, privacy review.
- **Observability** is the OpenTelemetry trace path. It is a no-operation until an operator sets an OTLP endpoint. A change needs lighter review while it keeps that gate and stays inside the span-attribute allowlist.
- **The run log** holds rows in the local `heartbeat_run_events` table. The data stays in the instance database, so a change needs no extra review.

Before you change any of these paths or add a Telemetry caller, read [`rules/data-paths.mdc`](rules/data-paths.mdc) for the exact file paths and review requirements.

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
- Form and wizard footers: keep Save & exit (or Cancel/Back) left and the primary action right in the same vertically aligned row. Each step owns the entire footer; never append Save & exit as a separate row. See `DESIGN.md`.

### Design system

`DESIGN.md` at the repo root is the source of truth for UI design decisions. The token-only rule applies to all `ui/` changes: every color, spacing, radius, type, shadow, and motion value in `ui/src/components/**` and `ui/src/pages/**` comes from the token layer in `ui/src/index.css` — no hex, raw px, arbitrary Tailwind bracket values, or raw `font-size`/`fontSize` declarations in components, outside the documented allowlist in `ui/src/index.css`. Run `pnpm check:token-gates` (`scripts/check-token-gates.mjs`) before committing UI changes — it fails on any violation not covered by that allowlist.

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

1. Behavior matches what the task asked for and preserves the invariants in section 5
2. Relevant local verification and required CI typecheck, test, and build checks pass for the final revision, with any acceptance or platform-specific gaps resolved (section 7)
3. Contracts are synced across db/shared/server/ui
4. Docs updated when behavior or commands change
5. PR description follows the [PR template](.github/PULL_REQUEST_TEMPLATE.md) with all sections filled in (including Model Used)
