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
- QA approval gate: code issues require a `QA: PASS` comment before moving to done
- Forward-only issue transitions are enforced; do not invent ad hoc backward resets to force work into motion
- Direct assignment is the primary control path for waking agents; do not rely on soft `@mention` choreography as the main handoff mechanism
- If a QA or validation run finds an implementation defect, the failing child lane must be reassigned back to an executable engineering/devops owner; do not leave failed implementation work blocked under QA ownership
- Parent validation/control lanes may remain with QA, but child implementation lanes must move to the next executable owner
- Merged is not validated; deployed is not board-ready; use implemented / deployed / validated / board-ready language precisely
- For code and delivery issues entering `in_review`, include a single structured review handoff comment containing explicit `Summary:`, `Branch:`, `Commit:`, `PR:`, `Checks:`, `Reviewer:`, and `Caveats:` fields

4. Operational control-plane rules for agent-executed issue work.
- Direct assignment + explicit state transition is the primary control path. `@mentions` and comments are advisory wake signals, not sufficient proof of pickup.
- Assignment alone is not progress. A task is only truly active when it has a dispatchable owner, a non-terminal executable state, and a fresh execution/adoption signal.
- When a board/Hermes/manager comment asks a direct question or gives explicit branches, the assignee must answer that instruction explicitly in the issue thread before ending the run.
- Critical runs must leave a short disposition comment that states: current branch/decision, recommended status, exact blocker or evidence, and next owner/next step.
- If an issue remains `blocked`, the comment must name the precise current blocker (for example deploy dependency, missing credential, failing runtime, or external decision). Do not leave `blocked` with stale or implied reasons.
- A green run is not enough. A run is incomplete if it succeeds technically but does not update the board-visible issue truth.
- Use state language precisely: `implemented`, `deployed`, `validated`, and `board-ready` are different claims and must not be collapsed.

5. Do not replace strategic docs wholesale unless asked.
Prefer additive updates. Keep `doc/SPEC.md` and `doc/SPEC-implementation.md` aligned.

6. Keep plan docs dated and centralized.
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

## 10. SSH Access

Agents with infrastructure responsibilities may SSH into assigned servers using key-based authentication only.

### Production Change Policy (GitHub-only)

Production hot fixes outside GitHub are forbidden.

Required path for every production change:

1. Commit changes to GitHub
2. Open/update PR
3. Required checks pass (`verify`, `policy`)
4. Merge to `master`
5. Deploy through GitHub Actions only (no VPS source edits)

Explicitly forbidden for production application changes:

- Direct editing of tracked source files on VPS (e.g. under `/opt/paperclip`)
- Ad-hoc server patching (`sed -i`, manual file rewrites, quick local hacks)
- Manual `docker compose build/up` as a deployment mechanism for app updates
- Any change that cannot be traced to a git commit and CI run

Emergency fixes still follow GitHub flow: commit -> checks -> merge -> workflow deploy.

### Connie VPS

Assigned to agents performing Connie infrastructure tasks (service patching, runtime inspection, archive operations).

Environment variables required (must be set before use; block and escalate if missing):

- `CONNIE_VPS_HOST` — IP or hostname of the Connie VPS
- `CONNIE_VPS_USER` — SSH login user (typically `root`)
- `CONNIE_SSH_KEY_PATH` — absolute path to the private key
- `CONNIE_KNOWN_HOSTS_PATH` — absolute path to the known_hosts file for this server

SSH command pattern:

```bash
ssh -i "$CONNIE_SSH_KEY_PATH" \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$CONNIE_KNOWN_HOSTS_PATH" \
  -o ConnectTimeout=10 \
  "$CONNIE_VPS_USER@$CONNIE_VPS_HOST"
```

Validate access before any task that requires it:

```bash
ssh -i "$CONNIE_SSH_KEY_PATH" \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$CONNIE_KNOWN_HOSTS_PATH" \
  -o ConnectTimeout=10 \
  "$CONNIE_VPS_USER@$CONNIE_VPS_HOST" \
  "echo SSH_OK && hostname && whoami"
```

Expected output:

```text
SSH_OK
connie-vps
root
```

Paste exact stdout/stderr output into the task comment when validating. Do not assume access to any server not listed here.

## 11. Operational Maintenance (Platform / Release)

These are the three CI actions that are **independent of each other** and all manual:

| Action | Command |
|--------|---------|
| Deploy app to VPS | `gh workflow run deploy-vultr.yml --repo Viraforge/paperclip --ref master` |
| Publish canary to npm | `gh workflow run release.yml --repo Viraforge/paperclip --ref master -f channel=canary` |
| Publish stable to npm | `gh workflow run release.yml --repo Viraforge/paperclip --ref master -f channel=stable` |

Canary also publishes automatically on a nightly schedule (02:00 UTC). No action required unless an on-demand canary is needed.

### Drift check

`deploy-drift-check.yml` runs on a schedule and compares the SHA on `master` with the SHA deployed on the VPS. If they differ, the check fails. **This is expected behavior** — it means `master` has commits that have not been deployed yet. Fix by running `deploy-vultr.yml`. Do not disable or suppress the drift check.

### Lockfile refresh

`pnpm-lock.yaml` must never be committed directly in a PR (`pr-policy` blocks it). The correct path when the lockfile is stale:

1. Trigger: `gh workflow run refresh-lockfile.yml --repo Viraforge/paperclip --ref master`
2. The workflow pushes updated lockfile to branch `chore/refresh-lockfile` but **cannot create the PR** (GitHub Actions lacks PR creation permission in this repo).
3. Open the PR manually:
   ```bash
   gh pr create --repo Viraforge/paperclip \
     --head chore/refresh-lockfile --base master \
     --title "chore(lockfile): refresh pnpm-lock.yaml" \
     --body "Auto-generated lockfile refresh."
   ```
4. Post `ai-review/verdict` status, then merge. The `pr-policy` check has a built-in exception for this branch.

### npm package scope

All packages are scoped `@paperclipai/` and marked `"private": true` to prevent accidental npm publishing. We use the upstream's scope for merge compatibility — packages are consumed only within the monorepo via pnpm workspace protocol, never published to npm.

## 12. Definition of Done

A change is done when all are true:

1. Behavior matches `doc/SPEC-implementation.md`
2. Typecheck, tests, and build pass
3. Contracts are synced across db/shared/server/ui
4. Docs updated when behavior or commands change
5. Code is pushed to a remote branch and a pull request is created (enforced by delivery gate for agent-authored code tasks)
6. **Engineer has verified the fix interactively** — the actual user flow was performed in a headed browser before handoff to QA. Evidence (screenshot, test output) included in handoff comment.
7. QA approval comment (`QA: PASS`) from a different agent or board user exists on the issue (enforced by QA gate — self-approval is blocked). **QA PASS must be based on interactive outcome testing** — grepping code, checking HTTP status codes, or zero-console-errors-on-load alone is not sufficient.
