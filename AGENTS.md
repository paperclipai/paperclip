# AGENTS.md

Guidance for human and AI contributors working in this repository.

## 1. Purpose

Paperclip is a control plane for AI-agent companies.
The current implementation target is V1 and is defined in `doc/SPEC-implementation.md`.

## 2. Read First

Read these before changing behavior:

1. `doc/GOAL.md`
2. `doc/PRODUCT.md`
3. `doc/SPEC-implementation.md`
4. `doc/DEVELOPING.md`
5. `doc/DATABASE.md`
6. `CONTRIBUTING.md`

`doc/SPEC.md` is long-horizon context. `doc/SPEC-implementation.md` is the current build contract.

## 3. Repo Map

- `server/`: REST API, orchestration, issue/task logic, auth, runtime behavior
- `ui/`: board UI, routes, components, client behavior
- `cli/`: CLI commands and operator workflows
- `packages/db/`: schema, migrations, DB clients
- `packages/shared/`: shared types, constants, validators, API paths
- `packages/adapters/`: adapter implementations
- `packages/adapter-utils/`: shared adapter/runtime utilities
- `packages/plugins/`: plugin runtime and bundled plugins
- `packages/skills-catalog/`: bundled skill packaging
- `tests/e2e/`, `tests/release-smoke/`: browser coverage
- `doc/`: product, release, and operator docs

When behavior crosses layers, update every affected contract in the same change.

## 4. Dev Setup

Use embedded PGlite in dev by leaving `DATABASE_URL` unset.

```sh
pnpm install
pnpm dev
```

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

## 5. Core Rules

1. Keep changes company-scoped.
Every domain entity must respect company boundaries.

2. Keep contracts synchronized.
If schema or API behavior changes, update the impacted `packages/db`, `packages/shared`, `server`, and `ui` layers together.

3. Preserve control-plane invariants.
- single-assignee task model
- atomic issue checkout semantics
- approval gates for governed actions
- budget hard-stop auto-pause behavior
- activity logging for mutating actions

4. Prefer additive docs changes unless asked otherwise.
Keep `doc/SPEC.md` and `doc/SPEC-implementation.md` aligned.

5. Keep repo plans in `doc/plans/` with `YYYY-MM-DD-slug.md` filenames.
If a Paperclip issue asks for a plan, update the issue `plan` document instead of adding a repo markdown file.

6. Upload inspectable artifacts before final disposition.
In this repo prefer `skills/paperclip/scripts/paperclip-upload-artifact.sh`, create/update the artifact work product when the file is the deliverable, and link the uploaded artifact in the final issue comment. See `doc/AGENT-ARTIFACTS.md` for examples.

## 6. Verification

Start with the smallest command that proves the changed surface:

- Docs or instruction-only change: verify links, commands, and references manually.
- Single Vitest-covered change: run the narrowest relevant test file.
- Server-only TypeScript change: `pnpm --filter @paperclipai/server typecheck`
- UI-only TypeScript change: `pnpm --filter @paperclipai/ui typecheck`
- Single package change: package typecheck plus the narrowest related test
- Cross-package contract change: `pnpm typecheck` plus targeted Vitest coverage

Broader checks when warranted:

```sh
pnpm test
pnpm typecheck
pnpm build
```

Repo specifics:

- `pnpm test` is the cheap default and runs Vitest via `scripts/run-vitest-stable.mjs`.
- Browser suites are opt-in: `pnpm test:e2e`, `pnpm test:release-smoke`.
- If workspace wiring changes, let the normal commands run `preflight:workspace-links`.
- For PR-ready handoff or broad refactors, run `pnpm typecheck`, `pnpm test:run`, and `pnpm build`.

If you skip a relevant check, say exactly what was not run and why.

## 7. Git Workflow

- Keep each branch or issue checkout focused on one logical change.
- Prefer a non-main branch and an isolated workspace or worktree.
- Push the branch before claiming task completion so reviewers can inspect durable remote state.
- When implementation is ready, create or update a `pull_request` work product on the issue and move review/merge onto an explicit review path.
- Repo task work is not done until the PR path is closed and the branch is merged back to base.
- Prefer linked worktrees or Paperclip-managed execution workspaces for parallel work.
- Do not commit `pnpm-lock.yaml` in pull requests. GitHub Actions owns lockfile regeneration here.
- If you touch release, CI, or package publishing, read the matching docs first.
- Before opening a PR, use [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) exactly as written.

## 8. Ownership Lenses

- API/orchestration: `server/`, issue lifecycle, approvals, auth, workspace/runtime logic
- UI: `ui/`, user flows, components, visual regressions
- CLI/operator workflow: `cli/`, plus `doc/CLI.md` and `doc/DEVELOPING.md`
- Data contracts: `packages/shared/` and `packages/db/`, with follow-through into `server/` and `ui/`
- Plugin/adapter: `packages/adapters/`, `packages/adapter-utils/`, `packages/plugins/`
- Docs/process: root docs, repo instructions, release/process docs

## 9. Database Changes

1. Edit `packages/db/src/schema/*.ts`
2. Ensure exports from `packages/db/src/schema/index.ts`
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

## 10. Hand-off Checks

Cheap default:

```sh
pnpm test
```

Browser suites stay opt-in:

```sh
pnpm test:e2e
pnpm test:release-smoke
```

Run the browser suites only when the change touches them or when explicitly verifying CI/release flows.

Full check before PR-ready handoff or broad changes:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

## 11. API and UI Expectations

- Base path is `/api`.
- Board access is full-control operator context.
- Agent access uses bearer API keys (`agent_api_keys`), hashed at rest.
- Agent keys must not access other companies.
- New endpoints must enforce company access, actor permissions, mutation logging, and consistent HTTP errors.
- Keep routes and nav aligned with available API surface.
- Use company selection context on company-scoped pages.
- Surface failures clearly; do not silently ignore API errors.

## 12. Pull Request Requirements

Every PR must follow [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) exactly, including:

- `Thinking Path`
- `What Changed`
- `Verification`
- `Risks`
- `Model Used`
- `Checklist`

## 13. Definition of Done

Done means all are true:

1. Behavior matches `doc/SPEC-implementation.md`.
2. Typecheck, tests, and build pass at the right scope.
3. Contracts are synced across db/shared/server/ui when relevant.
4. Docs are updated when behavior or commands change.
5. The PR description follows the required template.

## 14. Fork-Specific: HenkDz/paperclip

This fork externalizes the Hermes adapter on branch `feat/externalize-hermes-adapter`.

- Core should not depend on `hermes-paperclip-adapter`.
- Register Hermes through the Adapter Plugin manager.
- UI should use the package's config-schema and `ui-parser.js`, not source imports from `server/` or `ui/`.
