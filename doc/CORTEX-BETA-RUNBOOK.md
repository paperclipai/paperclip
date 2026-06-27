# cortex-beta — Refresh & Promotion Runbook

Status: Canonical operating runbook for the `cortex-beta` staging instance
Date: 2026-06-27
Issue: [NEO-257](/NEO/issues/NEO-257) · Parent plan: [NEO-217](/NEO/issues/NEO-217#document-plan)

> **Branch hygiene (D8).** This document — and the `beta-refresh.sh` script, the `.gitmodules`
> plugin wiring, and the beta instance files it describes — lives on the **`cortex-beta`
> branch only**. `Neoreef/plugin-*` may be private and Paperclip's `master` is public-facing,
> so this wiring **must never be merged into public `master`**. See NEO-251 / D8.

## 1. What cortex-beta is

`cortex-beta` is the **Staging** instance from `doc/DEV-PROCESS.md` §2: a longer-lived,
human-reachable instance for testing and guiding development of Cortex *and* its plugins
before changes are promoted to the live orchestrator. It is **not** the live control plane
and **not** a per-issue worktree.

| Property | Value |
|---|---|
| Public URL | `https://cortex-beta.neoreef.com` (Caddy → loopback) |
| Bind / port | `127.0.0.1:3200` (`PAPERCLIP_BIND=loopback`) |
| Supervision | `systemd` unit **`paperclip-beta.service`** (D5) |
| Source tree | runs **in place** from the shared canonical tree on branch **`cortex-beta`** (NEO-250) |
| Database | own embedded Postgres, **port 54330**, data `~/.paperclip/instances/beta/db` |
| Auth | `authenticated` + `private` (login required) (D3) |
| Migrations | **auto-applied at boot** — `PAPERCLIP_MIGRATION_AUTO_APPLY=true`, `PAPERCLIP_MIGRATION_PROMPT=never` |
| Instance home | `PAPERCLIP_INSTANCE_ID=beta`, config `~/.paperclip/instances/beta/config.json` |
| Plugin dir | isolated `~/.paperclip/instances/beta/plugins` (NOT live's `~/.paperclip/plugins`) (D6/D7) |
| Seed | empty / `--seed-mode minimal` — public-repo secret hygiene (D2) |

> **Load-bearing caveat — beta runs from the *shared canonical agent source*, not a
> worktree.** A refresh therefore **builds that shared tree in place**. This is the single
> sanctioned exception to DEV-PROCESS Hard Rule #5, and the reason refreshes happen only in
> **controlled windows** when no other agent is mid-build against the tree. The refresh
> script gates the build behind `--yes` / `BETA_REFRESH_CONFIRM=1` for exactly this reason.

## 2. Refresh runbook (`beta:refresh`)

A refresh is **build → migrate beta DB → restart** (plan decision **D1**). The migrate step
is performed by the **runtime at boot**: because the unit sets `PAPERCLIP_MIGRATION_AUTO_APPLY=true`,
every restart runs `applyPendingMigrations` (`server/src/index.ts` → `packages/db/src/client.ts`)
against beta's own DB. There is **no** separate `pnpm db:migrate` step, and (per the
hand-authored-migrations note, NEO-262) you should not run `drizzle-kit generate` here.

### Steps

```bash
# 0. Land the change on the cortex-beta branch (merge/cherry-pick into this tree's HEAD,
#    or bump a submodule pin). The service serves whatever is built from cortex-beta HEAD.

# 1. (Recommended) snapshot beta's DB first, so a bad migration is recoverable.
#    Backups also run hourly via config.json (retentionDays: 30).
#    A manual point-in-time backup:
PAPERCLIP_INSTANCE_ID=beta PAPERCLIP_CONFIG=~/.paperclip/instances/beta/config.json \
  pnpm db:backup        # → ~/.paperclip/instances/beta/data/backups

# 2. Pre-flight only (no build/restart) — verify branch, tree, submodule pins, health:
pnpm beta:refresh -- --check

# 3. Refresh in a controlled window (builds the shared tree, restarts, gates on health):
pnpm beta:refresh -- --yes
#    Equivalent: BETA_REFRESH_CONFIRM=1 ./scripts/beta-refresh.sh
```

`scripts/beta-refresh.sh --yes` does, in order: assert branch is `cortex-beta` → sync
submodules to their pinned commits → `pnpm install` → `pnpm build` →
`sudo systemctl restart paperclip-beta.service` (migrations auto-apply on boot) → poll
`http://127.0.0.1:3200/api/health` for up to 60s. On health failure it tails the beta log
and tells you to roll back.

### Manual equivalent (if the script is unavailable)

```bash
cd /home/ubuntu/.paperclip/instances/default/projects/0078c9af-…/8764704b-…/paperclip
git rev-parse --abbrev-ref HEAD          # must be cortex-beta
git submodule update --init --recursive
pnpm install && pnpm build               # NOTE: no NODE_ENV=production — build needs devDeps
sudo systemctl restart paperclip-beta.service
curl -fsS http://127.0.0.1:3200/api/health      # expect {"status":"ok",...,"bootstrapStatus":"ready"}
```

## 3. Rollback (D1 manual refresh to a known-good ref)

Rollback is the **same manual `beta:refresh` mechanism**, pointed at the last known-good
commit instead of HEAD. There is no separate rollback machine — that is the whole point of
D1 being a *manual* refresh: forward and back are the same controlled operation.

```bash
# Identify the last good commit (e.g. from the previous refresh's log line) and roll back:
pnpm beta:rollback <last-good-ref> -- --yes
#    Equivalent: ./scripts/beta-refresh.sh --rollback <last-good-ref> --yes
```

The script's `--rollback` path does a **non-forcing** `git checkout <ref>` (it refuses if the
tree has uncommitted tracked changes — clean them first), re-syncs submodules, rebuilds, and
restarts. If a *migration* (not just code) caused the failure, also restore the DB backup
taken in step 1 of §2 before restarting, since rolling code back does not undo an applied
migration.

**Rollback checklist**
1. `git stash`/commit any stray tracked changes (checkout is non-forcing).
2. `pnpm beta:rollback <last-good-ref> -- --yes`.
3. If a migration was the culprit: stop the service, restore the pre-refresh DB backup, then
   restart on the rolled-back code.
4. Confirm `curl -fsS http://127.0.0.1:3200/api/health` is `ok` and report.

## 4. Plugin-promotion procedure (validated submodule commit → live install bump)

Plugins are vendored as **git submodules** under `plugins/<name>` on the `cortex-beta` branch
(D6). Beta runs its *own* copies: `~/.paperclip/instances/beta/plugins/package.json` points
each plugin at the in-tree submodule folder via a `file:` dependency, fully decoupled from
the live install at `~/.paperclip/plugins`.

Promotion is the deliberate act of moving a **submodule commit you validated on beta** into
the **live** plugin install. It is **never an incidental side effect** of a refresh — it is a
governed, CTO-approved §5-style update, the same gate that governs promoting Paperclip itself.

### Procedure

1. **Validate on beta.** Bump the relevant submodule under `plugins/<name>` to the candidate
   commit on the `cortex-beta` branch, `pnpm beta:refresh -- --yes`, and exercise the plugin
   on `https://cortex-beta.neoreef.com`. Record the exact validated commit SHA
   (`git submodule status`).
2. **Open the governed update** (DEV-PROCESS §5 "Promotion to the live instance"): this is a
   discrete, CTO-approved operation, not a task side effect.
3. **Back up live first** — `npx paperclipai db:backup` against the live instance.
4. **Bump the live install ref** in `~/.paperclip/plugins/package.json` to the validated
   commit — a `github:Neoreef/plugin-<name>#<sha>` ref (or the live `file:` checkout advanced
   to that SHA). Use the **same SHA** validated on beta; never a moving branch ref.
5. Reinstall the live plugin dir and run the live promotion's `doctor --repair` + health
   check (DEV-PROCESS §5 / NEO-198 runbook).
6. **Rollback** = restore the previous `package.json` ref + backup, reinstall, health-check.

> Live and beta intentionally use different plugin-ref styles: live pins `github:…#<sha>`
> (public refs), beta uses `file:` into the in-tree submodules. Promotion translates a
> validated beta submodule SHA into the corresponding live `github:`/`file:` pin.

## 5. Verify / health

```bash
systemctl is-active paperclip-beta.service                 # active
curl -fsS http://127.0.0.1:3200/api/health                 # loopback
curl -fsS https://cortex-beta.neoreef.com/api/health       # via Caddy
tail -n 50 ~/.paperclip/instances/beta/logs/server.log     # boot + migration lines
```

A healthy response is `{"status":"ok","deploymentMode":"authenticated","deploymentExposure":"private","bootstrapStatus":"ready",...}`.

## 6. References

- `doc/DEV-PROCESS.md` — §2 Staging row points here; §5 governs the live promotion gate.
- `scripts/beta-refresh.sh` — the refresh/rollback implementation (cortex-beta branch only).
- Plan & decisions: [NEO-217](/NEO/issues/NEO-217#document-plan) (D1 refresh, D2–D8).
- Beta service topology: NEO-253 (systemd unit, isolated DB/plugins). Vendoring: NEO-251.
- Live promotion + rollback runbook: [NEO-198](/NEO/issues/NEO-198) (the §5 gate this reuses).
