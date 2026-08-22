---
title: Disk Retention
summary: Reclaiming disk from run logs, backups, and stale agent workspaces
---

A long-running local instance accumulates disk usage in three places that are
never automatically bounded by default:

| Directory | What it holds | Grows because |
|---|---|---|
| `data/run-logs/` | One NDJSON file per heartbeat run | Every heartbeat, forever |
| `data/backups/` | Periodic SQL dumps of the embedded database | `backup.intervalMinutes`, forever until `retentionDays` |
| `instances/*/workspaces/` | One git checkout per agent per issue (`git_worktree` / `local_fs` isolated execution) | Every assigned issue that isn't cleaned up |

See also [Backup & Restore](/deploy/database) for the backup timer itself and
[#2022](https://github.com/paperclipai/paperclip/issues/2022) for the broader
run-log/server-log retention request this page complements.

## Workspace / `node_modules` reclaim

`scripts/reap-stale-workspaces.mjs` reclaims disk from agent execution
workspaces without ever risking the data-loss failure modes described in
[#3207](https://github.com/paperclipai/paperclip/issues/3207) and
[#10555](https://github.com/paperclipai/paperclip/issues/10555) (both are real
incidents where a "cleanup" step destroyed unpushed or uncommitted work with
no recovery path).

```sh
# Dry run (default) — reports what would be reclaimed, deletes nothing.
node scripts/reap-stale-workspaces.mjs

# Actually reclaim node_modules from inactive, git-clean-enough worktrees.
node scripts/reap-stale-workspaces.mjs --apply

# Also remove entire worktrees once their branch is merged/closed, clean,
# fully pushed, and not in use — see "Safety tiers" below. Off by default.
node scripts/reap-stale-workspaces.mjs --apply --remove-merged-worktrees
```

### Safety tiers

The script never deletes anything unless it can positively prove it is safe;
any ambiguity, error, or missing signal (network failure calling `gh`, a
malformed git directory, `lsof` failing) fails **closed** — the candidate is
preserved, not reclaimed.

1. **`node_modules`-only reclaim (default, always on with `--apply`).**
   `node_modules` is never git-tracked, so removing it can never lose a
   commit or an edit — a plain package-manager install fully reproduces it
   from the lockfile. Required conditions:
   - no active agent/session has an open file handle or `cwd` under the
     directory right now (checked live via `lsof`, not inferred from issue
     or run status),
   - a recognized lockfile (`pnpm-lock.yaml`, `package-lock.json`,
     `yarn.lock`, or `bun.lockb`) is committed in the repo,
   - the lockfile itself has **no uncommitted changes** (`git status
     --porcelain` shows it clean). A lockfile can be *tracked* and still be
     mid-edit — in that state the working tree's dependency graph reflects the
     uncommitted lockfile, not the last committed one, so a reinstall from the
     committed lockfile would not reproduce this `node_modules`. Found on a
     live host, not merely theoretical: an in-progress dependency bump left
     `pnpm-lock.yaml` modified but uncommitted in an otherwise-idle worktree.
   - `git ls-files` reports **no tracked path under `node_modules/`**.
     `node_modules` is conventionally `.gitignore`'d, but nothing stops
     `git add -f` from committing a patched dependency file into it — if
     that ever happens, "reinstallable from the committed lockfile" is no
     longer true, since a plain reinstall silently overwrites that patch back
     to the vanilla upstream file. Caught by review before it could ship.

   This tier does **not** require the branch to be merged or the PR to be
   closed, because it never touches PR/branch/commit state at all.

2. **Full worktree removal (opt-in via `--remove-merged-worktrees`).**
   Deletes the entire checkout — branch included. Requires **all** of:
   - no active session (as above),
   - `git status --porcelain` is empty (nothing uncommitted),
   - the branch has no commits ahead of its upstream (nothing unpushed),
   - the branch's GitHub PR is `MERGED` or `CLOSED` — **never** while `OPEN`,
   - the directory is not a shared `git worktree` parent/child of another
     checkout still in use (`git worktree list` reports more than one entry),
   - no other local git state exists that only the *current* branch's
     PR/merge check does not see: an unpushed commit on a **different**
     local branch (a leftover branch that is itself fully mirrored on a
     remote — e.g. the default branch every plain `git clone` leaves
     checked out before a feature branch — is fine and does not block
     removal; only a branch with commits that exist nowhere else does), any
     `git stash` entry, or a tag pointing at a commit not reachable from the
     pushed upstream. Checked entirely locally (`git merge-base
     --is-ancestor`, no network call), and only computed once every other
     gate above already passed, so it costs nothing on the common
     node_modules-only path. Found by code review before it could ship:
     the original PR/merge check only validated the checked-out branch,
     not other branches/stashes/tags a worktree can also be carrying.

   Any one of these failing to hold — for any reason, including a lookup
   error — keeps the worktree and falls back to tier 1.

3. **Recent-commit guard (applies to both tiers, on by default).** `lsof`
   only proves "no process has an open file handle *right now*" — it cannot
   see an agent that is between tool calls, mid-thought, or about to push a
   follow-up commit. Found on a live host: a worktree with zero open file
   handles had a commit from 24 minutes earlier. Any worktree whose `HEAD`
   committed within the last `--recent-commit-minutes` (default: 60; env
   `REAP_RECENT_COMMIT_MINUTES`) is preserved regardless of every other
   signal. Pass `--recent-commit-minutes 0` to disable it explicitly.

4. **Revalidation immediately before delete (applies to both tiers).** Every
   safety fact above is evaluated once, up front, before the run decides
   which candidates to reclaim — but `--apply` can process many worktrees in
   one run, and a worktree evaluated as safe early in the run could have a
   session attach, a new commit land, or its lockfile go dirty by the time
   its turn to actually delete comes up. Immediately before each deletion,
   every underlying signal (active session, recent commit, lockfile
   dirtiness, and — for a full worktree removal — clean tree, not-ahead-of-
   remote, and the same extra-git-state check from tier 2) is re-checked
   fresh; if anything has changed since the original evaluation, the
   deletion is skipped and the candidate is downgraded to preserved instead.
   This does not close the race window entirely (there is still a gap
   between this re-check and the delete call itself), but it shrinks it from
   "the full duration of the run across every worktree" down to
   milliseconds — the right cost/benefit tradeoff versus a full lock/mutex
   mechanism for a maintenance script that already fails closed by default.

Every path the script touches is `realpath`-resolved and checked against an
allow-list of discovered worktree roots (or explicit `--root` overrides);
nothing outside that is ever evaluated, let alone deleted, including through
a symlink. Discovery covers two conventions seen in the wild:
`~/.paperclip*/instances/*/workspaces/<agent>/<checkout>` and the older,
still-active `~/.paperclip-worktrees/<checkout>` (real `git worktree`
checkouts directly under one shared directory, no `instances` layer).

### Idempotency

Running the script again after a successful `--apply` is a no-op: everything
already reclaimed is already gone, so the second run reports zero bytes
reclaimed and exits `0`.

## Wiring it in (LaunchAgent, no OS cron)

`scripts/install-paperclip-retention-agent.sh` installs a per-user
`launchd` LaunchAgent that runs the reaper (plus, if present on the host,
your existing run-log/backup retention scripts) on an interval — the same
mechanism Paperclip's own local instance already uses for background
maintenance, not a raw crontab entry.

```sh
scripts/install-paperclip-retention-agent.sh --install
# ... edit host-local config if needed, then:
scripts/install-paperclip-retention-agent.sh --uninstall
```

The installer is idempotent: re-running `--install` unloads and reloads the
existing agent instead of erroring or duplicating it. It writes only under
`~/Library/LaunchAgents/` and `~/.paperclip/`; it does not touch `/etc/cron*`,
`crontab`, or any system-level scheduler.

`node`'s absolute path is resolved once at install time (using this shell's
own, full `PATH`) and baked into the generated runner script. A `launchd` job
runs with a minimal `PATH` that typically excludes Homebrew/`nvm` bin
directories, so re-resolving a bare `node` at run time — the first version of
this script did that — silently no-ops every scheduled run. If `node` cannot
be resolved at install time at all, the installer refuses to install rather
than leave behind a job that always fails.

If your host already runs the run-log/backup retention scripts on their own
dedicated LaunchAgents (as this project's own host tooling does), do not also
wire them into `PAPERCLIP_RUN_LOGS_PRUNE_SCRIPT`/
`PAPERCLIP_BACKUP_RETENTION_SCRIPT` here — that would run the same script on
two overlapping schedules and risks a concurrent double-run. Those variables
exist for hosts where no such wiring exists yet.
