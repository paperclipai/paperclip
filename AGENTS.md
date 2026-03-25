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
