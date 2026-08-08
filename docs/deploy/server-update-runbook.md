# Server-Update Runbook — resetting the live serving tree to origin/master

Operational runbook for a self-hosted deploy workflow that keeps a live control-plane serving tree in sync by resetting it to `origin/master`. Written after the same durable-loss failure bit twice.

Companion to [dev-plane-restart-hygiene.md](dev-plane-restart-hygiene.md) (which covers *how* to restart without killing in-flight runs). This doc covers *what to check before the reset* so it never silently deletes an un-landed fix.

## Why this matters

`git reset --hard origin/master` is a **destructive rebuild** of the serving tree. Anything present only as local state that is not on `origin/master` is wiped. Two ways this bites in practice:

- A runtime **hotpatch applied only to the live tree**, never merged. A later reset reverts it and the original outage recurs.
- A fix **marked "done" on uncommitted live-tree state** and never merged. The next reset wipes it; if you're lucky it survives as an orphaned stash on a backup branch, but the live tree no longer runs it.

Root pattern: **"done on the live tree" ≠ durable.** A fix is only durable once it is on `origin/master`.

## The two rules

### Rule 1 — "done" gate for infra hotfixes

A fix that touches server runtime (anything the live tree serves) **must not be marked done on the basis of live-tree local state alone.** Require one of:

- a **merged commit SHA on `origin/master`** (the normal path), or
- an explicit, ticketed exception: *"live-hotpatch applied now, durable deploy tracked in #NNN"* — kept open with that follow-up as a first-class blocker, **not** closed.

If it isn't on `origin/master` and there's no tracked follow-up, it is one reset away from silent regression. Don't close it.

### Rule 2 — pre-flight before every reset

Before `git reset --hard origin/master`, run the pre-flight gate. It refuses (exit 2) when the tree carries divergence the reset would destroy or abandon and that hasn't been acknowledged:

```bash
node scripts/preflight-server-update.mjs          # targets $PAPERCLIP_LIVE_TREE or ~/Paperclip, fetches first
```

What it classifies (built on `reset --hard` semantics):

| State | Reset behavior | Verdict |
|-------|----------------|---------|
| Tracked uncommitted changes (staged/unstaged edits to tracked files) | **destroyed** | **block** |
| Commits ahead of `origin/master` | abandoned from branch ref (reflog/backup only) | **block** |
| Stashes | survive | warn |
| Untracked files | survive | info |

- **Exit 0** — clean (or blocking divergence explicitly acked). Safe to reset.
- **Exit 2** — blocked. Capture the blocking items on a backup branch and land them on `origin/master` (or track the durable deploy in a ticket), then re-run.
- The audited exception: `--ack "reason + #NNN ticket"` downgrades a block to `acked` (exit 0) and echoes the reason to the run log. Use a real ticket id.

Other flags: `--tree <path>` to inspect a different tree, `--no-fetch` to skip the `git fetch origin master`, `--json` for a machine-readable verdict.

## Full safe reset procedure

The live control plane runs from the primary checkout (`~/Paperclip` by default: launchd → `pnpm dev` → `dev-runner.ts watch` → inner `tsx watch src/index.ts` on `:3100`). Verify authoritatively with `lsof -nP -iTCP:3100 -sTCP:LISTEN` and `/api/health` `servingTree.head`.

0. **Pre-flight (Rule 2):** `node scripts/preflight-server-update.mjs`. Do not proceed on a `BLOCKED` verdict without capturing/ticketing the blocking items.
1. `npx paperclipai db:backup` **first** — pending migrations auto-apply to the live DB on restart.
2. Preserve divergent work: `git branch backups/server-update-<date> <HEAD>`. Note: a branch snapshot captures **committed** state only — it does **not** capture uncommitted working-tree edits or stashes. Those must be committed/stashed explicitly, which is exactly what the pre-flight forces you to notice.
3. `git fetch origin master && git reset --hard origin/master`; verify `HEAD == origin/master` and a clean tree.
4. `pnpm install` — **required** across a big jump or the restart crash-loops on missing imports (the supervisor does not run install). If this step bumps the `tsx` package itself, do **not** rely on a touch-file nudge to respawn — fully cycle the service: `pnpm run dev:stop` then `pnpm run dev:watch` (a running `tsx watch` supervisor holds deleted-file inodes from the old version and every child respawn then crashes on the vanished `preflight.cjs`).
5. Migrations auto-apply (`PAPERCLIP_MIGRATION_AUTO_APPLY=true`), or run `pnpm db:migrate`. UI is served via Vite dev middleware from source — no `pnpm build` needed.
6. Restart is gated on active agent runs (a DB count). To force a fresh worker during an agent run, make a real content change to a watched src file then revert (an mtime-only `touch` is not detected by tsx watch).

## After the reset — reconciliation check (closes the loop for Rule 1)

Once the API is back healthy, **diff the backup branch against `origin/master`** to catch any fix that was live-only and just got reverted:

```bash
git log --oneline origin/master..backups/server-update-<date>
git diff --stat origin/master backups/server-update-<date>
```

Any hunk that is a real runtime fix and is **not** on `origin/master` → spin out a re-land follow-up issue and link it. Only then close the reset task.

Also confirm end state: `/api/health` `servingTree.head == origin/master`, a single `:3100` listener, the notifier/gateway plugin reconnected (check `~/.paperclip/gateway-liveness.json` freshness separately from `/api/health` — the plugin worker's lifecycle is not tied 1:1 to `src/index.ts` reloads), and a recent DB backup.

## See also

- [dev-plane-restart-hygiene.md](dev-plane-restart-hygiene.md) — restarting without killing in-flight runs.
- `scripts/preflight-server-update.mjs` — the pre-flight gate (Rule 2), with `--json` / `--ack` / `--tree` / `--no-fetch`.
