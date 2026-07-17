# Dev Paperclip Instance — Safe Development Process

Status: Canonical process for developing Paperclip without breaking the live instance
Date: 2026-06-18

## 1. Purpose

Cortex agents are assigned to develop **Paperclip itself**. The catch: the **live
orchestrator that runs those very agents** is deployed from the same canonical source the
agents edit (promoted into its own separate runtime tree — see §2). Without isolation, a
build, migration, seed, restart, or dirty git state — whether against that shared canonical
source or against the live runtime directly — can take down the control plane, including
the run that issued the command. This is the literal "agents break the very system we are
using to build the system" failure.

This document defines the **instance topology** (which instance is which, and its rule)
and the **paperclip-dev Hard Rules** that every agent must follow. It is the in-repo,
human-readable anchor for the safe development process. The companion `paperclip-dev`
skill carries the same rules so every agent inherits them by default; this doc and that
skill must stay in sync.

> Scope: this is **in-repo documentation only**. It does not, by itself, change any
> platform source, project configuration, or workspace policy. The enforcement pieces
> (workspace-policy flip, fail-closed pre-flight guard, cleanup/reaper, company skill,
> promotion runbook) are tracked as the sibling subtasks of the Board-approved plan on
> [NEO-189](/NEO/issues/NEO-189).

## 2. Instance Topology

There are **five** trees/environments in play. Only one of them is the live control plane,
and it is **never** a build/test/migrate/restart target. The live runtime and the canonical
agent source are **two different directories** — do not conflate them. Know which is which
before you run anything.

| Role | What it is | Where | Rule |
|------|-----------|-------|------|
| **Live / Orchestrator (runtime)** | The running Paperclip control plane that assigns and runs Cortex agents. Treat it as production. | Controller host, served by **`paperclip.service`** from **`/home/ubuntu/projects/paperclip`** (port `3100`, its own embedded Postgres), fronted by Caddy as `cortex.neoreef.com`. | **Never** a build / test / migrate / seed / restart / port-bind target. Changes reach it only via the governed promotion path (§5). |
| **Canonical agent source (project workspace)** | The shared `project_primary` source tree every issue resolves to and syncs back into — what agents actually edit. **Not** a running server. | `/home/ubuntu/.paperclip/instances/default/projects/0078c9af-…/8764704b-…/paperclip` — and `/home/ubuntu/.paperclip` is a **symlink to `/data/paperclip`**, so this is the same tree as `/data/paperclip/instances/…/paperclip`. | Promoted into the live runtime via §5. Shared across concurrent agents: never trash it (dirty git state, stray build/migrate, or a second server bound to it) and never make it a build/migrate target — use an isolated worktree instead. |
| **Dev (per-issue worktree instance)** | Ephemeral, isolated Paperclip instance with its **own** Postgres DB and server port, created via the `worktree` CLI (`cli/src/commands/worktree.ts`). | Under the worktree home (separate DB + port, printed by `worktree env`) | This is **where agents actually build / run / migrate / seed / smoke-test.** One per issue. Cleaned up when done. |
| **Execution remote (sandbox)** | The SSH box where the adapter process runs a **synced copy** of the source; changes are exported back to the canonical tree. | `brian@172.31.0.32:2022`, path `/mnt/c/inetpub/.paperclip-runtime/runs/<runId>/workspace` — the legacy **Neoreef Platform** box (`EC2AMAZ-V5Q175O`, IIS/ASP.NET) | **Source edits only.** It is **not** a Paperclip runtime. Do **not** start a Paperclip server/DB here and treat it as "the dev instance." Its `localhost`/ports are not the controller's. |
| **Staging (`cortex-beta`)** | Longer-lived, human-reachable instance for testing and guiding development of Cortex *and* its plugins before promotion to live. Runs the `cortex-beta` branch **in place from its own deploy tree `/home/ubuntu/projects/cortex-beta`** (NOT the canonical agent-source tree) — its own DB and plugin dir, not a worktree, not the live plane. | `https://cortex-beta.neoreef.com` → `paperclip-beta.service` (`WorkingDirectory=/home/ubuntu/projects/cortex-beta/server`) on **`127.0.0.1:3200`** (loopback/private), server from **source** via `pnpm exec tsx src/index.ts` (no server build), UI from **`ui/dist`** (`pnpm build`), `NODE_ENV=production`, own embedded Postgres (**:54330**), isolated plugin dir `~/.paperclip/instances/beta/plugins`. | Deployed by the **pull-based on-host deploy agent** (`scripts/cortex-deploy.sh` + `cortex-deploy.timer`, [NEO-526](/NEO/issues/NEO-526)): ff `cortex-beta`→merged `origin/master` → `pnpm build` → restart → health + content-verify gate ([NEO-527](/NEO/issues/NEO-527)) with auto-rollback. Migrations **auto-apply on boot** (`PAPERCLIP_MIGRATION_AUTO_APPLY=true`). The one sanctioned exception to Hard Rule #5 (it builds its tree in place), serialized in controlled windows — see the deploy/promotion runbook **`doc/CORTEX-BETA-RUNBOOK.md`**. Promotion of validated plugin commits to live goes through the §5 gate, never as a side effect. |

### Why the distinction is load-bearing

There are **two** dangerous targets — **not** `/mnt/c/inetpub`:

1. The **live orchestrator runtime** (`/home/ubuntu/projects/paperclip`, `paperclip.service`,
   port `3100` → `cortex.neoreef.com`). Never a direct build / `db:migrate` / `db:generate` /
   seed / server-restart / port-bind target; it changes only via the §5 promotion path.
2. The **shared canonical agent source**
   (`/home/ubuntu/.paperclip/instances/default/…/paperclip` ≡ `/data/paperclip/…`) that the
   project's workspace policy resolves every issue to and **syncs back** into. Because it is
   shared across every concurrent agent, a build / migrate / seed / dirty git state / stray
   server bound to it corrupts work in flight for everyone and feeds bad state into the next
   promotion — unless you deliberately target an isolated worktree instance instead.

The SSH-remote indirection does **not** protect against (2): the synced-back source is this
canonical tree, not a throwaway.

This is also why any enforcement guard must key off an **explicit instance-role marker**,
not host/port/URL heuristics — under the SSH realization the adapter runs on a *different*
host where `localhost` and ports differ from the controller, so those heuristics are
actively misleading.

## 3. Verified Topology — Evidence

These paths and classifications were verified directly against the issue's
execution-workspace (`GET /api/execution-workspaces/…`) and the live filesystem
(per [NEO-189](/NEO/issues/NEO-189) plan §0), not inferred:

| Element | Reality | Evidence |
|---|---|---|
| **Canonical agent source (project workspace)** | `/home/ubuntu/.paperclip/instances/default/projects/0078c9af-…/8764704b-…/paperclip` on the **controller host**; `/home/ubuntu/.paperclip` is a **symlink to `/data/paperclip`**, so this is the same inode as `/data/paperclip/instances/…/paperclip`. The path embeds **this** companyId + projectId. **Source tree agents edit — not a running server.** | `workspaceRealization.local.path` + `cwd`; `source = project_primary`; `repoUrl = github.com/Neoreef/paperclip`; `readlink /home/ubuntu/.paperclip → /data/paperclip` (NEO-217) |
| **Live orchestrator runtime** (where `cortex.neoreef.com` actually runs) | `/home/ubuntu/projects/paperclip` — a **separate** tree from the canonical source above, served by `paperclip.service`. | `systemctl` unit `paperclip.service` (`WorkingDirectory=/home/ubuntu/projects/paperclip/server`, `PORT=3100`, `PUBLIC_URL=https://cortex.neoreef.com`); listening pid `cwd=/home/ubuntu/projects/paperclip`; Caddy `reverse_proxy 127.0.0.1:3100` (NEO-217) |
| **Execution remote** (where the adapter process actually runs) | `brian@172.31.0.32:2022`, path `/mnt/c/inetpub` — the legacy **Neoreef Platform** box (`EC2AMAZ-V5Q175O`, IIS/ASP.NET `Neoreef OneNet 2023.sln`). **Not Paperclip.** | `workspaceRealization.remote = {host,port,username,path}`; `whoami=brian`, `hostname=EC2AMAZ-V5Q175O`; `/mnt/c/inetpub` is the Neoreef platform tree |
| **Per-run workspace** | A **synced copy** of the canonical source, materialized on the remote at `/mnt/c/inetpub/.paperclip-runtime/runs/<runId>/workspace`, then exported back. | `workspaceRealization.sync.strategy = ssh_git_import_export` (prepare = import local→remote; syncBack = export remote→local) |
| **Staging (`cortex-beta`) deploy tree** | `/home/ubuntu/projects/cortex-beta` — a **separate** tree from the canonical agent source, served by `paperclip-beta.service`. Server runs from **source** (`tsx`, no server build); UI is served from `ui/dist`. | `systemctl cat paperclip-beta.service` → `WorkingDirectory=/home/ubuntu/projects/cortex-beta/server`, `ExecStart=pnpm exec tsx src/index.ts`, `NODE_ENV=production`, `PORT=3200`, `HOST=127.0.0.1`; confirmed against `/proc/<MainPID>/cwd` (NEO-530) |
| **Current workspace policy** | `mode = shared_workspace`, `strategyType = project_primary`, `providerType = local_fs`. | execution-workspace record (confirmed, not inferred) |

> Note: the current `shared_workspace` / `project_primary` policy is the state these
> verified facts describe. The plan's Layer-2 subtask flips it to `isolated_workspace` +
> `git_worktree`; update this section if/when that lands.

## 4. Hard Rules (Company Policy)

These rules exist because agents have caused real damage by improvising around CLI
failures. They are **company policy**, not suggestions. They mirror the `paperclip-dev`
skill — follow them exactly.

1. **CLI is the only interface to worktrees and databases.** All worktree and database
   operations MUST go through `npx paperclipai` / `pnpm paperclipai` commands. You MUST NOT:
   - Run `pg_dump`, `pg_restore`, `psql`, `createdb`, `dropdb`, or any raw Postgres commands.
   - Manually set `DATABASE_URL` to point a worktree server at another instance's database.
   - Run `rm -rf` on any `.paperclip/`, `.paperclip-worktrees/`, or `db/` directory.
   - Directly manipulate embedded Postgres data directories.
   - Kill Postgres processes by PID.

2. **Never repoint `DATABASE_URL` across instances.** Each worktree instance gets its own
   isolated database. Never override `DATABASE_URL` to point one instance at another's
   database. This destroys isolation and can corrupt the live control-plane data.

3. **Never `rm -rf` `.paperclip*`.** Removing `.paperclip/`, `.paperclip-worktrees/`, or
   instance `db/` directories by hand can delete the live instance's data. Tear down
   worktree instances with the CLI (`worktree:cleanup`) only.

4. **If a CLI command fails, stop and report — do not improvise.** Do NOT attempt
   workarounds. If `worktree:make`, `worktree reseed`, `worktree init`,
   `worktree:cleanup`, or any other `paperclipai` command fails:
   - Report the exact error message in your task comment.
   - Set the task to `blocked`.
   - Suggest `npx paperclipai doctor --repair` or recreating the worktree from scratch.
   - Do NOT try to manually replicate what the CLI does.

5. **Never build / test / migrate / seed / restart against the live orchestrator
   instance.** Anything that runs Paperclip targets a **worktree-local instance** (own DB +
   port), never `/home/ubuntu/.paperclip/instances/default/…/paperclip`. The live instance
   reaches new code only via the governed promotion path (§5).

6. **Persistent dev servers run via `tmux`.** A dev server that must outlive the current
   heartbeat (e.g. for human or QA testing) MUST be launched in a named, detached `tmux`
   session — not `nohup` or a bare `&`, which die when the heartbeat's process group is
   killed. Verify the port is listening before reporting the URL, and kill the session when
   done.

7. **Default seed mode is `minimal`.** When provisioning a worktree instance, default to
   `--seed-mode minimal`. `--seed-mode full` clones live data and risks leaking secrets
   into a public repo, so it requires **explicit per-use CTO approval** (open-source
   hygiene — this repository is public-facing).

## 5. Working Safely — the Per-Issue Loop

Any task that must **build, run, migrate, seed, or restart** Paperclip does so against a
worktree-local instance, then promotes via PR. The live instance is never an incidental
side effect of a task.

```bash
# 1. Create an isolated worktree instance (own DB + port), minimal seed
npx paperclipai worktree:make <name> --start-point origin/master --seed-mode minimal

# 2. Enter the worktree and source ITS environment (own port lives here)
cd <worktree-path>
eval "$(npx paperclipai worktree env)"

# 3. Build / typecheck / test against the worktree instance — never the live one
pnpm install && pnpm build && pnpm typecheck && pnpm test

# 4. Verify against the worktree's OWN port (printed by `worktree env`),
#    NOT the live instance's port
curl -sf http://127.0.0.1:<worktree-port>/api/health

# 5. Clean up when done
npx paperclipai worktree:cleanup <name>
```

### Merge path

- Branch per issue → PR to `Neoreef/paperclip`, **base branch `master`** (**fork-first**
  if a personal fork remote exists; the synced run workspace has no git remote, so the
  merge path runs from the canonical source / a fork, not the sandbox copy).
- PR must satisfy `CONTRIBUTING.md`, `.github/PULL_REQUEST_TEMPLATE.md`, and the
  `.github/workflows/pr.yml` CI gates; `pnpm typecheck && pnpm test && pnpm build` must be
  green in the isolated worktree instance first.
- Review by Werner (CTO) or a designated reviewer. Large/untrusted diffs use the
  **Docker For Untrusted PR Review** flow (`doc/UNTRUSTED-PR-REVIEW.md`).
- `check:no-git-push` guards accidental pushes — keep it on.
- **If your change alters observable behavior on beta**, ship a release probe at
  `release-probes/<ISSUE>.yaml` in the **same PR** (`bundle` / `route` / `db`). The beta deploy
  agent runs it as a content-verify gate after each deploy — see `doc/CORTEX-BETA-RUNBOOK.md` §5.2
  and [NEO-527](/NEO/issues/NEO-527). This is what proves your work actually reached beta
  (content, never SHA ancestry).

> The gates, the `master` trigger, and the fork-first flow above are verified with
> file-level evidence in **§6**.

> **Beta is the one sanctioned in-place-build exception to Hard Rule #5.** Everything above
> builds/tests against an **isolated worktree instance**. The single exception is the
> `cortex-beta` **Staging** instance (§2), which rebuilds its own deploy tree
> (`/home/ubuntu/projects/cortex-beta`) in place — automated by the pull-based deploy agent
> (`scripts/cortex-deploy.sh` + `cortex-deploy.timer`, [NEO-526](/NEO/issues/NEO-526)), serialized
> in controlled windows. It never touches the live orchestrator or the canonical agent source.
> Promotion of a validated beta build/plugin commit to **live** still goes through the governed
> gate below — never as a side effect of a beta deploy. Full runbook: `doc/CORTEX-BETA-RUNBOOK.md`.

### Promotion to the live instance (governed, reversible)

Updating the live orchestrator from `master` is a discrete, **CTO-approved** operation,
never an incidental side effect of a task:

1. `npx paperclipai db:backup` **first**.
2. Pull `master` → `pnpm install && pnpm build` → `pnpm db:generate && pnpm db:migrate`
   (prefer a low-activity window; never while the live instance is mid-build).
3. `npx paperclipai doctor --repair` + health check.
4. **Rollback** if unhealthy: restore the backup, revert to the previous build.

The detailed promotion + rollback runbook is tracked as
[NEO-198](/NEO/issues/NEO-198).

## 6. Verified CI / PR Path

This section records the **verified** merge path for `Neoreef/paperclip`: what gates run,
on which branch, and from where pushes originate. Verified against the workspace at
`af2e0036` (file:line citations are to that tree).

### 6.1 The integration branch is `master`, and the PR gate fires on it

`pr.yml` triggers only on PRs **targeting `master`**:

```yaml
# .github/workflows/pr.yml:3-6
on:
  pull_request:
    branches:
      - master
```

`master` (not `main`) is the canonical integration branch: every branch-gated workflow
keys on it — `pr.yml`, `docker.yml`, `release.yml`, and `refresh-lockfile.yml` — and the
repo history merges `upstream/master`. **A PR opened against any other branch (e.g. `main`)
does not trigger `pr.yml` at all**, so the base branch must be `master`.

GitHub runs the **base repository's** workflow definition for `pull_request` events. The
gates therefore execute on `Neoreef/paperclip` (the base) regardless of whether the PR head
lives on the canonical repo or on a personal fork — a fork's own Actions never substitute
for the base repo's required checks. Recent squash-merged PRs (#6–#10 in `git log`) are
direct evidence the gate has been exercising on real PRs into `master`.

### 6.2 CI gates (`pr.yml`) — evidence

| Gate (job) | What it enforces | Evidence (`.github/workflows/pr.yml`) |
|---|---|---|
| `policy` | Blocks manual `pnpm-lock.yaml` edits, validates Dockerfile deps stage, **runs `check:no-git-push` + its test**, validates the release package manifest + bootstrap, regenerates the lockfile when manifests change. | lines 13–90 |
| `typecheck_release_registry` | `typecheck:build-gaps` + release-registry coverage. | 92–127 |
| `general_tests` (matrix: `server`, `workspaces-a`, `workspaces-b`) | Grouped general suites. | 129–171 |
| `build` | `pnpm build`. | 192–224 |
| `verify_serialized_server` (4 shards) | Serialized server suites. | 226–274 |
| `canary_dry_run` | `release.sh canary --skip-verify --dry-run`. | 276–329 |
| `e2e` | Playwright e2e (Chrome, LLM-skipped). | 331–396 |
| `verify` (**required check**) | Aggregate gate: `always()`, asserts `typecheck_release_registry`, `general_tests`, and `build` each `== success`. This is the legacy required-check name branch protection points at. | 173–190 |

### 6.3 `check:no-git-push` stays enabled

The guard rejects `git push` (and remote-mutating git invocations) in adapter/runtime
source — the local execution-workspace cwd is the only cross-run persistence boundary, so
adapter/runtime code must never push. It is wired into CI as part of the **required
`policy` job**, not an optional lane:

```yaml
# .github/workflows/pr.yml:52-56
- name: Reject git push in adapter/runtime code
  run: node ./scripts/check-no-git-push.mjs
- name: Test no-git-push check
  run: node --test ./scripts/check-no-git-push.test.mjs
```

- npm scripts: `check:no-git-push` → `node scripts/check-no-git-push.mjs`;
  `test:check-no-git-push` → `node --test scripts/check-no-git-push.test.mjs` (`package.json`).
- The guard scans `packages/adapters`, `packages/adapter-utils`, `server/src`, `cli/src`
  (`scripts/check-no-git-push.mjs:25-30`); the only escape hatch is an explicit
  `paperclip:allow-git-push` marker reserved for reviewed, operator-configured paths.

Keep this step in `pr.yml` and the script in `package.json`; removing either silently drops
the guard.

### 6.4 Fork-first push + PR-template flow

The synced run workspace has **no git remote configured** (`git remote -v` is empty —
verified this run), so you cannot push from the sandbox. The merge path runs from the
canonical checkout or a personal fork:

1. Branch per issue from `origin/master`.
2. **Fork-first:** push the branch to your personal fork if one exists; otherwise push the
   branch on the canonical repo. (No remote in the sandbox copy — push from a real checkout.)
3. Open the PR with **base `Neoreef/paperclip:master`**.
4. Fill `.github/PULL_REQUEST_TEMPLATE.md` — Thinking Path, Linked Issues, What Changed,
   Verification, Risks, **Model Used**, and the Checklist (incl. "All Paperclip CI gates are
   green" and "Greptile is 5/5"). `CONTRIBUTING.md` → "Use the PR Template" requires the
   template even when the PR is opened via the GitHub API/tooling (copy it in manually).
5. CI (`pr.yml` on the base) must be green; `pnpm typecheck && pnpm test && pnpm build` must
   pass in the isolated worktree instance first (§5).

### 6.5 Large / untrusted diffs — Docker review

For diffs you do not want touching the host, review inside the isolated container
(`doc/UNTRUSTED-PR-REVIEW.md`):

```sh
docker compose -f docker/docker-compose.untrusted-review.yml run --rm --service-ports review
review-checkout-pr <owner>/<repo> <pr#>
```

It keeps `gh`/`codex`/`claude` auth, the clone, installs, and the local DB inside container
volumes; it does **not** mount the host repo, host home, or SSH agent by default. Treat the
PR as hostile input; run `pnpm install`/`pnpm dev` only when you intentionally want to
execute the PR's code.

## 7. References

- Plan & governance: [NEO-189](/NEO/issues/NEO-189) (Board-approved; CTO conditions C1–C3).
- `paperclip-dev` skill — the same Hard Rules, applied to every agent at runtime.
- `doc/DEVELOPING.md` — canonical CLI command reference (worktrees, DB ops, build/test).
- `doc/UNTRUSTED-PR-REVIEW.md` — Docker-isolated review flow for large/untrusted diffs.
- `doc/DEPLOYMENT-MODES.md` — runtime/auth/reachability model.
- `doc/CORTEX-BETA-RUNBOOK.md` — refresh/rollback + plugin-promotion runbook for the
  `cortex-beta` Staging instance (§2 Staging row). (cortex-beta branch only — D8.)
