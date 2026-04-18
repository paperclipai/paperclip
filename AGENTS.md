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

6. Bump versions on every application push.
Every PR/push that changes a shipped application must include the corresponding version bump in source before merge:
- web apps: update `package.json` and any user-visible app version surface
- extensions: update `manifest.json`
- future applications: apply the same rule to their canonical version file
If no shipped artifact changed, say that explicitly in the PR/task context. Never merge or ship an application change without a version bump.

## 7. Database Change Workflow

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

## 8. Verification Before Hand-off

Run this full check before claiming done:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

If anything cannot be run, explicitly report what was not run and why.

## 9. API and Auth Expectations

- Base path: `/api`
- Board access is treated as full-control operator context
- Agent access uses bearer API keys (`agent_api_keys`), hashed at rest
- Agent keys must not access other companies

When adding endpoints:

- apply company access checks
- enforce actor permissions (board vs agent)
- write activity log entries for mutations
- return consistent HTTP errors (`400/401/403/404/409/422/500`)

## 10. UI Expectations

- Keep routes and nav aligned with available API surface
- Use company selection context for company-scoped pages
- Surface failures clearly; do not silently ignore API errors

### Route Guard Standards (all web applications)

These rules apply to every web application the team builds — ViraCue, Paperclip board UI, and any future product.

**1. Default-open, selectively restrict.** All routes start with basic authentication only (e.g. `RequireAuth`). Admin gates (`RequireOrgAdmin`, `RequireSuperAdmin`, etc.) are added only to genuinely administrative routes — user management, org settings, billing configuration. Core product pages (dashboard, simulator, live session, training) are NEVER admin-gated.

**2. Sidebar visibility must match route guards.** If a route uses an admin guard, the sidebar link to that route must check the same condition. Shipping a guard without hiding the corresponding sidebar link is incomplete work. Shipping a sidebar link to a route the user can't access is a bug.

**3. Every web project must maintain a route access matrix.** The matrix is a living document at `docs/route-access-matrix.md` (or equivalent path in the project repo) that maps every route to its required role, guard component, and sidebar visibility. Format:

| Route | Auth Required | Min Role | Guard Component | Sidebar Visible To |
|-------|--------------|----------|-----------------|-------------------|
| /dashboard | Yes | any authenticated | RequireAuth | all |
| /admin | Yes | super_admin | RequireSuperAdmin | super_admin |
| /users | Yes | org:admin | RequireOrgAdmin | org:admin |

Every row must have both the route guard AND the sidebar visibility — they must match.

**4. Any PR that adds or changes a route guard, sidebar link, or auth middleware MUST update the route access matrix in the same PR.** PR reviewers check the matrix entry before approving. A PR that changes guards without updating the matrix is incomplete.

**5. PRs touching auth/routing must include a role test table.** See the PR template checklist for the required format. The engineer must verify each role can access the routes it should and cannot access routes it shouldn't.

### Playwright Test Requirements (all web applications)

Every web application with authentication MUST have:

**1. Role-matrix smoke test** — an automated test that verifies each role can access permitted routes and is blocked from restricted routes. Test matrix must cover at minimum: admin user, standard member, and unauthenticated visitor. Test file should live at `tests/webapp/route-access.spec.ts` or equivalent.

**2. Onboarding/critical-path smoke test** — an automated test that walks the primary user journey end-to-end (e.g., sign up -> onboarding -> dashboard -> first feature use). This test must run on PRs touching auth or onboarding files.

**3. Tests must use the route access matrix as their source of truth.** If the matrix says a member can access `/dashboard`, the test asserts it. If the matrix says a member cannot access `/admin`, the test asserts a redirect or access-denied page.

## 11. SSH Access

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

### Vultr VPS (Paperclip platform deploy target)

The Vultr VPS (`216.155.152.143`) runs the Paperclip platform via Docker Compose.
Access is via SSH key stored as `VULTR_SSH_PRIVATE_KEY` in GitHub Actions secrets
(`Viraforge/paperclip` repo). **Do not store the SSH private key in workspace files.**

**Emergency SSH access (last resort):** If the GitHub Actions secret and workspace key are both
unavailable, use the Vultr console in the Vultr control panel for emergency access.

For routine operations, use the GitHub Actions workflows (`deploy-vultr.yml`,
`rotate-vps-ssh-key.yml`) — they handle SSH key injection automatically.

### SSH Key Rotation (Vultr VPS)

When the VPS SSH key needs to be rotated (e.g., after suspected compromise or per policy):

```bash
gh workflow run rotate-vps-ssh-key.yml --repo Viraforge/paperclip --ref master
```

The workflow (`.github/workflows/rotate-vps-ssh-key.yml`) performs a zero-downtime rotation:
1. Generates a new Ed25519 key pair.
2. Adds the new public key to VPS `~/.ssh/authorized_keys` (old key still present).
3. Updates `VULTR_SSH_PRIVATE_KEY` GitHub Actions secret with the new private key.
4. Verifies the new key works end-to-end.
5. Removes the old public key from VPS `authorized_keys`.

**Prerequisite:** `VULTR_SSH_PRIVATE_KEY` and `VULTR_KNOWN_HOSTS` must already exist as repo
secrets (the workflow needs the current key to reach the VPS on steps 2 and 5).
On first-time setup, manually add the initial key to the VPS and set the GitHub secret,
then all future rotations are fully automated.

### Break-glass SSH key rotation (when the workflow can't reach the VPS)

If `rotate-vps-ssh-key.yml` fails at its "Verify old key access" step — meaning the current
`VULTR_SSH_PRIVATE_KEY` secret no longer pairs with any entry in VPS `authorized_keys` —
the automated workflow cannot run. This happened on 2026-04-18 (see issue #311) when the
VPS `authorized_keys` was pruned to only the `alfred@paperclip` key, leaving GHA without
any valid identity. Recover manually from an instance admin's laptop:

1. **Generate a fresh ed25519 keypair in a temp directory** (do not pollute `~/.ssh/`):
   ```bash
   mkdir -p /tmp/deploy-keygen && cd /tmp/deploy-keygen
   ssh-keygen -t ed25519 -N "" -C "deploy@github-actions-viraforge-paperclip" -f ./id_ed25519
   ```
2. **SSH to the VPS using the documented break-glass access** (Vultr control panel, or
   operator-held password if available) and append the new public key to `authorized_keys`
   without removing any existing entries:
   ```bash
   PUB=$(cat /tmp/deploy-keygen/id_ed25519.pub)
   ssh root@<VPS_HOST> "echo '$PUB' >> /root/.ssh/authorized_keys"
   ```
3. **Verify the new key authenticates** before updating the GHA secret:
   ```bash
   ssh -i /tmp/deploy-keygen/id_ed25519 -o PasswordAuthentication=no root@<VPS_HOST> 'echo OK'
   ```
4. **Update the GHA secret** with the new private key:
   ```bash
   gh secret set VULTR_SSH_PRIVATE_KEY --repo Viraforge/paperclip < /tmp/deploy-keygen/id_ed25519
   ```
5. **Wipe the local keypair** — no need to keep it:
   ```bash
   rm -rf /tmp/deploy-keygen
   ```
6. **Validate end-to-end** by pushing a tiny commit to `master` and watching `Deploy Vultr`.
   The `Verify SSH access` step should succeed with the new key.

After this, future rotations can use the normal `rotate-vps-ssh-key.yml` workflow again.

### nginx Config Management (Vultr VPS)

The source of truth for the VPS nginx configuration is `deploy/nginx/vps-edge.conf` in this repo.
The `deploy-vultr.yml` workflow automatically deploys this file to
`/etc/nginx/sites-available/viracue.conf` and runs `nginx -t && nginx -s reload`
after every successful deploy. **Never edit nginx config directly on the VPS.**

Key things tracked in `vps-edge.conf`:
- `/openai-realtime-proxy` WebSocket location block (required for simulator;
  caused downtime in DLD-828, DLD-1602 — now automated).
- Cloudflare `X-Forwarded-Proto` handling for HTTPS.
- WebSocket upgrade headers (`Upgrade`, `Connection`).

To change nginx config: edit `deploy/nginx/vps-edge.conf`, merge to `master`,
then trigger `deploy-vultr.yml`. The nginx reload is included in the deploy pipeline.

## 12. Operational Maintenance (Platform / Release)

These are the four CI actions that are **independent of each other** and all manual:

| Action | Command |
|--------|---------|
| Deploy app to VPS | `gh workflow run deploy-vultr.yml --repo Viraforge/paperclip --ref master` |
| Rotate VPS SSH key | `gh workflow run rotate-vps-ssh-key.yml --repo Viraforge/paperclip --ref master` |
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

## 13. Definition of Done

A change is done when all are true:

1. Behavior matches `doc/SPEC-implementation.md`
2. Typecheck, tests, and build pass
3. Contracts are synced across db/shared/server/ui
4. Docs updated when behavior or commands change
5. Code is pushed to a remote branch and a pull request is created (enforced by delivery gate for agent-authored code tasks)
6. **Engineer has verified the fix interactively** — the actual user flow was performed in a headed browser before handoff to QA. Evidence (screenshot, test output) included in handoff comment.
7. QA approval comment (`QA: PASS`) from a different agent or board user exists on the issue (enforced by QA gate — self-approval is blocked). **QA PASS must be based on interactive outcome testing** — grepping code, checking HTTP status codes, or zero-console-errors-on-load alone is not sufficient.
8. **For auth/routing/guard changes:** route access matrix updated, role test table completed in PR, sidebar visibility verified to match guards.
9. **For auth/routing/guard changes:** QA tested as BOTH admin AND non-admin roles. Single-role testing is an automatic QA FAIL.

## 14. Learned Rules

Rules derived from repeated friction, corrections, or process failures. These are permanent
addenda to the above sections.

### executionRunId deadlock self-healing

When an issue's `executionRunId` points to a queued/stuck run that never executed (created
minutes or hours ago, still queued), all mutations fail with `Issue run ownership conflict`.

- `executionRunId` present + queued → checkout returns 409; ALL mutations blocked.
- `executionRunId` absent/null → checkout succeeds; PATCH proceeds normally.
- Same-agent stale runs (executionRunId belongs to your own agent): done-bypass FAILS —
  checkout 409, PATCH 409. Resolution: CTO DB intervention, or wait ~2h for system self-heal.
- Cross-agent stale runs: done-bypass SUCCEEDS (status-only PATCH to `done` bypasses
  ownership check).
- After any successful PATCH, `executionRunId` updates to a new value — any subsequent
  mutation from the same heartbeat run is then blocked. Keep mutations minimal within a run.

### done_requires_qa_pass self-approval workaround

The `done_requires_qa_pass` gate blocks the done transition when the QA agent itself is the
assignee (self-approval scenario). The workaround:

1. QA posts their PASS comment.
2. Reassign from QA to SPE (or another agent) via `PATCH assigneeAgentId`.
3. SPE adds a brief comment and PATCHes to `done` in a fresh heartbeat.
4. Exception: if QA is routing to SPE for GitHub/CI work, SPE's done transition is
   independent of the gate — a plain status PATCH to `done` is sufficient.

Never retry a self-approval PATCH after it fails. Obtain a fresh PASS from QA or route to
another agent for the done transition.

### SPE-GitHub-Route protocol

When QA routes a GitHub/CI-dependent task to SPE (Senior Platform Engineer), the routing
comment must include:
- (a) exact GitHub action required (e.g., "push branch", "merge PR", "run workflow")
- (b) PR or workflow number if known
- (c) explicit "after completing, transition to done" instruction

SPE GitHub/CI routing target: agent ID `227d0125-9d34-4287-8ee8-39c4903f85b0`.
SPE owns: gh CLI auth, workflow dispatches, PR operations, VPS SSH-based deploys.
SPE does NOT own: browser-based QA (QA Agent), security reviews (Security Engineer).

### Corrections threshold escalation

When a root cause appears in `corrections.md` 3 or more times with no durable fix, create
a dedicated HIGH-priority fix ticket and route to the appropriate engineer within 24h of the
3rd occurrence. Do not allow 10+ corrections on the same root cause without a focused fix
ticket. Track the ticket in the issue and link it in the corrections log.

### Task-reading access order

When inspecting a Paperclip board task/thread for context or review, use this access order:

1. Use the Paperclip API first with board-member access.
2. If API access is unavailable, use SSH/database access next.
3. Only use the UI after API and SSH/database access both fail.

Do not start with the UI when the task data is reachable through the API or database.

### Agent instruction ownership

Keep repo-wide policy in this file limited to rules that apply broadly across contributors and agents.

Detailed role-specific operating procedure belongs in each agent's Paperclip-managed instruction
bundle (`AGENTS.md`, `HEARTBEAT.md`, `SOUL.md`, etc.), not here.

When a role-specific rule is important enough to move out of the shared repo policy, ensure the
target agent's managed instruction bundle remains self-sufficient and includes all critical
context needed for that agent to operate correctly after the move.

Paperclip-managed agent instruction bundles are the source of truth for role-specific behavior.
Do not create parallel repo-only copies of detailed per-agent operating policy unless a task
explicitly requires an exported snapshot for documentation or migration purposes.
