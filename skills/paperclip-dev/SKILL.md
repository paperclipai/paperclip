---
name: paperclip-dev
required: false
description: >
  Develop and operate a local Paperclip instance — start and stop servers,
  pull updates from master, run builds and tests, manage worktrees, back up
  databases, and diagnose problems. Use whenever you need to work on the
  Paperclip codebase itself or keep a running instance healthy.
---

# Paperclip Dev

This skill covers the day-to-day workflows for developing and operating a local Paperclip instance. It assumes you are working inside the Paperclip repo checkout with `origin` pointing to `git@github.com:paperclipai/paperclip.git`.

> **OPEN SOURCE HYGIENE:** This repository is public-facing. Treat anything you push to `origin` as publishable. Never commit or push secrets, API keys, tokens, private logs, PII, customer data, or machine-local configuration that should stay private. Keep git history tidy as well: avoid pushing throwaway branches, noisy checkpoint commits, or speculative work that does not need to be shared upstream.

> **MANDATORY:** Before running any CLI command, building, testing, or managing worktrees, you MUST read `doc/DEVELOPING.md` in the Paperclip repo. It is the canonical reference for all `paperclipai` CLI commands, their options, build/test workflows, database operations, worktree management, and diagnostics. Do NOT guess at flags or options — read the doc first.

## Quick Command Reference

These are the most common commands. For full option tables and details, see `doc/DEVELOPING.md`.

| Task | Command |
|------|---------|
| Start server (first time or normal) | `npx paperclipai run` |
| Dev mode with hot reload | `pnpm dev` |
| Stop dev server | `pnpm dev:stop` |
| Build | `pnpm build` |
| Type-check | `pnpm typecheck` |
| Run tests | `pnpm test` |
| Run migrations | `pnpm db:migrate` |
| Regenerate Drizzle client | `pnpm db:generate` |
| Back up database | `npx paperclipai db:backup` |
| Health check | `npx paperclipai doctor --repair` |
| Print env vars | `npx paperclipai env` |
| Trigger agent heartbeat | `npx paperclipai heartbeat run --agent-id <id>` |
| Install agent skills locally | `npx paperclipai agent local-cli <agent> --company-id <id>` |

## Pulling from Master

```bash
git fetch origin && git pull origin master
pnpm install && pnpm build
```

If schema changes landed, also run `pnpm db:generate && pnpm db:migrate`.

## Worktrees

Paperclip worktrees combine git worktrees with isolated Paperclip instances — each gets its own database, server port, and environment seeded from the primary instance.

> **MANDATORY:** Before creating or managing worktrees, you MUST read the "Worktree-local Instances" and "Worktree CLI Reference" sections in `doc/DEVELOPING.md`. That is the canonical reference for all worktree commands, their options, seed modes, and environment variables.

### When to Use Worktrees

- Starting a feature branch that needs its own Paperclip environment
- Running parallel agent work without cross-contaminating the primary instance
- Testing Paperclip changes in isolation before merging

### Command Overview

The CLI has two tiers (see `doc/DEVELOPING.md` for full option tables):

| Command | Purpose |
|---------|---------|
| `worktree:make <name>` | Create worktree + isolated instance in one step |
| `worktree:list` | List worktrees and their Paperclip status |
| `worktree:merge-history` | Preview/import issue history between worktrees |
| `worktree:cleanup <name>` | Remove worktree, branch, and instance data |
| `worktree init` | Bootstrap instance inside existing worktree |
| `worktree env` | Print shell exports for worktree instance |
| `worktree reseed` | Refresh worktree DB from another instance |
| `worktree repair` | Fix broken/missing worktree instance metadata |

### Typical Workflow

```bash
# 1. Create a worktree for a feature
npx paperclipai worktree:make my-feature --start-point origin/main

# 2. Move into the worktree (path printed by worktree:make) and source the environment
cd <worktree-path>
eval "$(npx paperclipai worktree env)"

# 3. Start the isolated Paperclip server
npx paperclipai run

# 4. Do your work

# 5. When done, merge history back if needed
npx paperclipai worktree:merge-history --from paperclip-my-feature --to current --apply

# 6. Clean up
npx paperclipai worktree:cleanup my-feature
```

## Forks — Prefer Pushing to a User Fork

If the user has a personal fork of `paperclipai/paperclip` configured as a git remote, push your feature branches to **that fork** instead of creating branches on the main repo. This keeps the upstream branch list clean and matches the standard open-source contribution flow.

### Detect a fork remote

Before pushing or creating a PR, list remotes and check for one that points at a non-`paperclipai` GitHub fork:

```bash
git remote -v
```

Treat any remote whose URL points to `github.com:<user>/paperclip` (or `github.com/<user>/paperclip.git`) as the user's fork. Common names are `fork`, `<username>`, or `myfork`. The remote named `origin` or `upstream` that points at `paperclipai/paperclip` is the canonical upstream — do not push feature branches there if a fork exists.

### Pushing to the fork

```bash
# Push the current branch to the user's fork and set upstream
git push -u <fork-remote> HEAD
```

Then create the PR from the fork branch:

```bash
gh pr create --repo paperclipai/paperclip --head <fork-owner>:<branch-name> ...
```

`gh pr create` usually figures out the head ref automatically when run from a branch tracking the fork; the explicit `--head <owner>:<branch>` form is the reliable fallback when it does not.

### When no fork exists

If `git remote -v` shows only `paperclipai/paperclip` remotes (no user fork), fall back to pushing branches to `origin` as before. Do NOT create a fork on the user's behalf — ask first.

### Keeping the fork up to date

The canonical remote that points at `paperclipai/paperclip` may be named `origin` **or** `upstream` depending on how the user set up the repo. Detect it the same way as in the "Detect a fork remote" step, then fetch and push from/with that remote so the sync works under either convention:

```bash
UPSTREAM_REMOTE=$(git remote -v | awk '/paperclipai\/paperclip.*\(fetch\)/{print $1; exit}')
git fetch "$UPSTREAM_REMOTE"
git push <fork-remote> "${UPSTREAM_REMOTE}/master:master"
```

## Pull Requests

> **MANDATORY PRE-FLIGHT:** Before creating ANY pull request, you MUST read the canonical source files listed below. Do NOT run `gh pr create` until you have read these files and verified your PR body matches every required section.

### Step 1 — Read the canonical files

You MUST read all three of these files before creating a PR:

1. **`.github/PULL_REQUEST_TEMPLATE.md`** — the required PR body structure
2. **`CONTRIBUTING.md`** — contribution conventions, PR requirements, and thinking-path examples
3. **`.github/workflows/pr.yml`** — CI checks that gate merge

### Step 2 — Validate your PR body against this checklist

After reading the template, verify your `--body` includes every one of these sections (names must match exactly):

- [ ] `## Thinking Path` — blockquote style, 5-8 reasoning steps
- [ ] `## What Changed` — bullet list of concrete changes
- [ ] `## Verification` — how a reviewer confirms this works
- [ ] `## Risks` — what could go wrong
- [ ] `## Model Used` — provider, model ID, version, capabilities
- [ ] `## Checklist` — copied from the template, items checked off

If any section is missing or empty, do NOT submit the PR. Go back and fill it in.

### Step 3 — Create the PR

Only after completing Steps 1 and 2, run `gh pr create`. Use the template contents as the structure for `--body` — do not write a freeform summary.

## Hard Rules — Do NOT Bypass

These rules exist because agents have caused real damage by improvising around CLI failures. Follow them exactly.

1. **CLI is the only interface to worktrees and databases.** All worktree and database operations MUST go through `npx paperclipai` / `pnpm paperclipai` commands. You MUST NOT:
   - Run `pg_dump`, `pg_restore`, `psql`, `createdb`, `dropdb`, or any raw postgres commands
   - Manually set `DATABASE_URL` to point a worktree server at another instance's database
   - Run `rm -rf` on any `.paperclip/`, `.paperclip-worktrees/`, or `db/` directory
   - Directly manipulate embedded postgres data directories
   - Kill postgres processes by PID

2. **If a CLI command fails, stop and report.** Do NOT attempt workarounds. If `worktree:make`, `worktree reseed`, `worktree init`, `worktree:cleanup`, or any other `paperclipai` command fails:
   - Report the exact error message in your task comment
   - Set the task to `blocked`
   - Suggest running `npx paperclipai doctor --repair` or recreating the worktree from scratch
   - Do NOT try to manually replicate what the CLI does

3. **Never share databases between instances.** Each worktree instance gets its own isolated database. Never override `DATABASE_URL` to point one instance at another's database. This destroys isolation and can corrupt production data.

4. **Starting a dev server in a worktree requires setup first.** The correct sequence is:
   ```bash
   # If the worktree already exists but has no running instance:
   cd <worktree-path>
   eval "$(npx paperclipai worktree env)"
   pnpm install && pnpm build
   npx paperclipai run          # or pnpm dev

   # If the worktree needs a fresh database:
   npx paperclipai worktree reseed --seed-mode full

   # If the worktree is broken beyond repair:
   npx paperclipai worktree:cleanup <name>
   npx paperclipai worktree:make <name> --seed-mode full
   ```
   If any step fails, follow rule 2 — stop and report.

5. **Seeding is a CLI operation.** When asked to seed a worktree database from the main instance, use `worktree reseed` or recreate with `worktree:make --seed-mode full`. Read `doc/DEVELOPING.md` for the full option tables. Never attempt manual database copying.

## Persistent Dev Servers (for Manual Testing)

When an agent needs to start a dev server that outlives the current heartbeat — for example, so a human or QA agent can manually test against it — the server process **must** be launched in a detached session. A process started directly from a heartbeat shell is killed when the heartbeat exits.

### Use `tmux` for persistent servers

```bash
# 1. cd into the worktree (or main repo) and source the environment
cd <worktree-path>
eval "$(npx paperclipai worktree env)"   # skip if using the primary instance

# 2. Start the dev server in a named, detached tmux session
tmux new-session -d -s <session-name> 'pnpm dev'

# Example with a descriptive name:
tmux new-session -d -s auth-fix-3102 'pnpm dev'
```

### Managing the session

| Task | Command |
|------|---------|
| Check if the session is alive | `tmux has-session -t <session-name> 2>/dev/null && echo running` |
| View server output | `tmux capture-pane -t <session-name> -p` |
| Kill the session | `tmux kill-session -t <session-name>` |
| List all tmux sessions | `tmux list-sessions` |

### Verifying the server is reachable

After launching, confirm the port is listening before reporting success:

```bash
# Wait briefly for startup, then verify
sleep 3
curl -sf http://127.0.0.1:<port>/api/health && echo "Server is up"
lsof -nP -iTCP:<port> -sTCP:LISTEN
```

### Key rules

1. **Always use `tmux` (or equivalent)** when a dev server needs to stay running after the heartbeat ends. A server started directly from the agent shell will die when the heartbeat exits, even if it appeared healthy moments before.
2. **Name the session descriptively** — include the worktree name and port (e.g., `auth-fix-3102`).
3. **Verify the server is listening** before reporting the URL to anyone.
4. **Do not use `nohup` or `&` alone** — these are unreliable for agent shells that may have their entire process group killed.
5. **Clean up when done** — kill the tmux session when the testing is complete.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Server won't start | Run `npx paperclipai doctor --repair` to diagnose and auto-fix |
| Forgetting to source worktree env | Run `eval "$(npx paperclipai worktree env)"` after cd-ing into the worktree |
| Stale dependencies after pull | Run `pnpm install && pnpm build` after pulling |
| Schema out of date after pull | Run `pnpm db:generate && pnpm db:migrate` |
| Reseeding while target DB is running | Stop the target server first, or use `--allow-live-target` |
| Cleaning up with unmerged commits | Merge or push first, or use `--force` if intentionally discarding |
| Running agents against wrong instance | Verify `PAPERCLIP_API_URL` points to the correct port |
| CLI command fails | Do NOT work around it — report the error and block (see Hard Rules above) |
| Agent tries manual postgres operations | NEVER do this — all DB ops go through the CLI (see Hard Rules above) |
| Dev server dies between heartbeats | Launch in a detached `tmux` session — see "Persistent Dev Servers" above |
| Pushed feature branch to `paperclipai/paperclip` when a fork exists | Push to the user's fork remote instead — see "Forks" above |
