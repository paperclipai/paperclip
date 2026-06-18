# Dev Paperclip Instance — Safe Development Process

Status: Canonical process for developing Paperclip without breaking the live instance
Date: 2026-06-18

## 1. Purpose

Cortex agents are assigned to develop **Paperclip itself**. The catch: the **live
orchestrator instance that runs those very agents** is built from the same canonical
source the agents edit. Without isolation, a build, migration, seed, restart, or dirty
git state from one task can take down the control plane — including the run that issued
the command. This is the literal "agents break the very system we are using to build the
system" failure.

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

There are **four** environments in play. Only one of them is the live control plane, and
it is **never** a build/test/migrate/restart target. Know which is which before you run
anything.

| Role | What it is | Where | Rule |
|------|-----------|-------|------|
| **Live / Orchestrator** | The running Paperclip control plane that assigns and runs Cortex agents. Treat it as production. | Controller host: `/home/ubuntu/.paperclip/instances/default/projects/0078c9af-…/8764704b-…/paperclip` (+ its Postgres DB + its serving port) | **Never** a build / test / migrate / seed / restart / port-bind target. Changes reach it only via the governed promotion path (§5). |
| **Dev (per-issue worktree instance)** | Ephemeral, isolated Paperclip instance with its **own** Postgres DB and server port, created via the `worktree` CLI (`cli/src/commands/worktree.ts`). | Under the worktree home (separate DB + port, printed by `worktree env`) | This is **where agents actually build / run / migrate / seed / smoke-test.** One per issue. Cleaned up when done. |
| **Execution remote (sandbox)** | The SSH box where the adapter process runs a **synced copy** of the source; changes are exported back to the canonical tree. | `brian@172.31.0.32:2022`, path `/mnt/c/inetpub/.paperclip-runtime/runs/<runId>/workspace` — the legacy **Neoreef Platform** box (`EC2AMAZ-V5Q175O`, IIS/ASP.NET) | **Source edits only.** It is **not** a Paperclip runtime. Do **not** start a Paperclip server/DB here and treat it as "the dev instance." Its `localhost`/ports are not the controller's. |
| **Staging (optional, deferred)** | Longer-lived shared instance running merged `main`, for integration testing before promotion. | TBD | Not provisioned today. Rely on ephemeral per-issue worktree instances; add staging only if per-issue isolation proves insufficient. |

### Why the distinction is load-bearing

The dangerous target is the **single live orchestrator instance on the controller**
(`/home/ubuntu/.paperclip/instances/default/…/paperclip` + its DB + its serving port) —
**not** `/mnt/c/inetpub`. Because the project's workspace policy resolves every issue to
that one canonical source (and run changes **sync back** to it), build / `db:migrate` /
`db:generate` / seed / server-restart / port-bind run against the live instance unless
you deliberately target an isolated worktree instance. The SSH-remote indirection does
**not** protect against this: the synced-back source is the live instance's own install
directory.

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
| **Canonical source + LIVE orchestrator instance** | `/home/ubuntu/.paperclip/instances/default/projects/0078c9af-…/8764704b-…/paperclip` on the **controller host** (the machine running the Paperclip control plane that orchestrates Cortex agents). The path embeds **this** companyId + projectId. | `workspaceRealization.local.path` + `cwd`; `source = project_primary`; `repoUrl = github.com/Neoreef/paperclip` |
| **Execution remote** (where the adapter process actually runs) | `brian@172.31.0.32:2022`, path `/mnt/c/inetpub` — the legacy **Neoreef Platform** box (`EC2AMAZ-V5Q175O`, IIS/ASP.NET `Neoreef OneNet 2023.sln`). **Not Paperclip.** | `workspaceRealization.remote = {host,port,username,path}`; `whoami=brian`, `hostname=EC2AMAZ-V5Q175O`; `/mnt/c/inetpub` is the Neoreef platform tree |
| **Per-run workspace** | A **synced copy** of the canonical source, materialized on the remote at `/mnt/c/inetpub/.paperclip-runtime/runs/<runId>/workspace`, then exported back. | `workspaceRealization.sync.strategy = ssh_git_import_export` (prepare = import local→remote; syncBack = export remote→local) |
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
npx paperclipai worktree:make <name> --start-point origin/main --seed-mode minimal

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

- Branch per issue → PR to `Neoreef/paperclip` (**fork-first** if a personal fork remote
  exists; the synced run workspace has no git remote, so the merge path runs from the
  canonical source / a fork, not the sandbox copy).
- PR must satisfy `CONTRIBUTING.md`, `.github/PULL_REQUEST_TEMPLATE.md`, and the
  `.github/workflows/pr.yml` CI gates; `pnpm typecheck && pnpm test && pnpm build` must be
  green in the isolated worktree instance first.
- Review by Werner (CTO) or a designated reviewer. Large/untrusted diffs use the
  **Docker For Untrusted PR Review** flow (`doc/UNTRUSTED-PR-REVIEW.md`).
- `check:no-git-push` guards accidental pushes — keep it on.

### Promotion to the live instance (governed, reversible)

Updating the live orchestrator from `main` is a discrete, **CTO-approved** operation,
never an incidental side effect of a task:

1. `npx paperclipai db:backup` **first**.
2. Pull `main` → `pnpm install && pnpm build` → `pnpm db:generate && pnpm db:migrate`
   (prefer a low-activity window; never while the live instance is mid-build).
3. `npx paperclipai doctor --repair` + health check.
4. **Rollback** if unhealthy: restore the backup, revert to the previous build.

The detailed promotion + rollback runbook is tracked as
[NEO-198](/NEO/issues/NEO-198).

## 6. References

- Plan & governance: [NEO-189](/NEO/issues/NEO-189) (Board-approved; CTO conditions C1–C3).
- `paperclip-dev` skill — the same Hard Rules, applied to every agent at runtime.
- `doc/DEVELOPING.md` — canonical CLI command reference (worktrees, DB ops, build/test).
- `doc/UNTRUSTED-PR-REVIEW.md` — Docker-isolated review flow for large/untrusted diffs.
- `doc/DEPLOYMENT-MODES.md` — runtime/auth/reachability model.
