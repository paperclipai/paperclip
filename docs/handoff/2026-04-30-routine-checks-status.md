# Routine-Checks Migration — Session Handoff

**Date:** 2026-04-30
**Branch:** `feat/paperclip-routine-checks`
**Tip:** `cf3fb751`
**Spec:** `docs/specs/2026-04-30-paperclip-routine-checks.md` (rev 3 + polish)
**Plan:** `docs/plans/2026-04-30-paperclip-routine-checks.md`

## Goal

Migrate 5 paperclip-domain routine checks (workspace-drift-guard, subscription-shadow-sync, creative-lint-nightly, drive-marker-ttl, approved-freshness) from Hermes cron prompts and openclaw shell scripts into the paperclip server. Hermes becomes Telegram-webhook delivery layer. Openclaw keeps only workspace-meta + host-health.

## Branch state

- `feat/paperclip-routine-checks` is ahead of `master` by 31 commits
- Includes spec (4 commits) + plan (1 commit) + impl (26 commits)
- Not pushed to remote
- JWT-Auth work on `fix/hermes-adapter-jwt-auth-patch` is untouched (uncommitted state preserved across switches)

## Phases COMPLETED (1–11, paperclip-side)

| # | Phase | Commits | Tests |
|---|---|---|---|
| 1 | DB schema (`routine_check_runs`) | 1 | n/a |
| 2 | Types + Registry | 4 | 6 |
| 3 | Notify dispatcher | 3 | 29 |
| 4 | Runner + catch-up + race-protection | 6 | 17 + 3 cron |
| 5 | workspace-drift-guard | 2 | 8 |
| 6 | subscription-shadow-sync | 2 | 9 |
| 7 | creative-lint-nightly | 2 (1 paperclip + 1 openclaw `8e33274`) | 5 |
| 8 | drive-marker-ttl | 1 | 7 |
| 9 | approved-freshness | (combined w/ 8) | 10 |
| 10 | Boot wiring | 1 | 2 |
| 11 | CLI `paperclip checks {list\|run\|history}` | 1 | smoke |
| 10/11 | post-review hardening | 1 | — |

**Total:** 26 paperclip commits + 1 openclaw commit. **93 routine-checks tests pass. typecheck server + CLI clean.**

CLI smoke output (verified):

```
5 routine checks registered:
  workspace-drift-guard         0 9,18,22 * * *       threshold
  subscription-shadow-sync      */30 * * * *          silent
  creative-lint-nightly         30 2 * * *            silent
  drive-marker-ttl              */15 * * * *          silent
  approved-freshness            0 7 * * 1             threshold
```

## Phases OUTSTANDING (12–16, deployment-side)

| # | Phase | Repo | Estimated |
|---|---|---|---|
| 12 | Hermes webhook + SQLite-dedupe | `~/Code/hermes-agent` | medium |
| 13 | Openclaw heartbeat-check + LaunchAgent | `~/.openclaw/workspace` | small |
| 14 | Pre-cutover: notify-token, snapshots, paperclip-server LaunchAgent | mixed | small |
| 15 | Live cutover (5-min window, pause-not-delete Hermes jobs) | mixed | small + risk |
| 16 | 7-day verification + cleanup | mixed | small |

Plan file `docs/plans/2026-04-30-paperclip-routine-checks.md` has step-by-step instructions for all 5.

## Verified repo conventions (relevant for future work)

- **Schema files:** `packages/db/src/schema/<snake_case>.ts`. Multi-line alphabetical imports from `drizzle-orm/pg-core`. Index export added topically (not at end).
- **Server source:** `server/src/services/<group>/<thing>.ts`. Imports use `.js` extensions (NodeNext ESM).
- **Server tests:** flat under `server/src/__tests__/<name>.test.ts`. Imports can use `.ts` or `.js` (both work via vitest).
- **CLI commands:** `cli/src/commands/<name>.ts`, registered via `registerXxxCommands(program: Command)` pattern. Pattern follows `routines.ts` / `db-backup.ts`. Use `process.env.DATABASE_URL` then `readConfig()` from `../config/store.js`. Close DB via `db.$client?.end?.({ timeout: 5 })`.
- **DB type:** `import type { Db } from "@paperclipai/db"`.
- **Cross-package imports:** server exposes subpath exports `@paperclipai/server/routine-checks` and `@paperclipai/server/routine-checks/runner` (added to `server/package.json`).
- **Real-DB tests:** `getEmbeddedPostgresTestSupport` + `startEmbeddedPostgresTestDatabase` from `./helpers/embedded-postgres.js`. Migrations auto-applied. `describe.skip` guard if not supported.
- **Truncate between tests:** `TRUNCATE TABLE ... RESTART IDENTITY CASCADE` in `afterEach`.
- **Test runner:** `npx vitest run __tests__/<file>.test.ts` from `server/` dir (no vitest pnpm script).
- **Typecheck:** `pnpm --filter @paperclipai/server typecheck` + `pnpm --filter @paperclipai/cli typecheck`.

## Critical drizzle/postgres learnings

- `db.execute(sql\`...\`)` returns row array DIRECTLY (not `{ rows }` wrapper). Implementation uses defensive `extractRows<T>(result)` helper that handles both shapes.
- `IN (...)` clauses: use `IN (${sql.join(values.map(v => sql\`${v}\`), sql\`, \`)})` pattern. `= ANY(${array})` does NOT work with this driver.
- `::timestamptz` casts require ISO string parameter, not Date object. Use `.toISOString()` before binding.
- UTC throughout. `mostRecentPastSlot` uses `getUTC*` accessors to match existing `nextCronTick`.

## Schedule semantics caveat

Spec literal schedules (`0 9,18,22 * * *` etc.) are interpreted UTC by paperclip cron. Hermes ran them in local time (CEST = UTC+2). At cutover, decide whether to:
- Keep literal spec schedules (drift fires at 09/18/22 UTC = 11/20/24 CEST — 2h shift)
- Convert to local-time-equivalents (`0 7,16,20 * * *` UTC = 09/18/22 CEST)

Recommend converting at cutover-time. Document in commit. None of the 5 schedules has been adjusted yet.

## Files added (this branch)

```
docs/handoff/2026-04-30-routine-checks-status.md           # this file
docs/specs/2026-04-30-paperclip-routine-checks.md
docs/plans/2026-04-30-paperclip-routine-checks.md
packages/db/src/schema/routine_check_runs.ts
packages/db/src/schema/index.ts                             # 1-line export added
packages/db/src/migrations/0058_chilly_shriek.sql           # CREATE TABLE + 3 indexes
packages/db/src/migrations/meta/{_journal.json,0058_snapshot.json}

server/src/services/cron.ts                                 # extended with mostRecentPastSlot
server/src/services/routine-checks/types.ts
server/src/services/routine-checks/registry.ts
server/src/services/routine-checks/notify.ts
server/src/services/routine-checks/runner.ts
server/src/services/routine-checks/boot.ts
server/src/services/routine-checks/checks/workspace-drift-guard.ts
server/src/services/routine-checks/checks/subscription-shadow-sync.ts
server/src/services/routine-checks/checks/creative-lint-nightly.ts
server/src/services/routine-checks/checks/drive-marker-ttl.ts
server/src/services/routine-checks/checks/approved-freshness.ts

server/src/__tests__/cron.test.ts                            # mostRecentPastSlot tests
server/src/__tests__/routine-checks-{registry,notify,runner,boot,
                                    workspace-drift-guard,
                                    subscription-shadow-sync,
                                    creative-lint-nightly,
                                    drive-marker-ttl,
                                    approved-freshness}.test.ts

server/src/index.ts                                         # startRoutineChecks call + SIGTERM await
server/package.json                                         # subpath exports for CLI consumption

cli/src/commands/checks.ts
cli/src/index.ts                                            # registerChecksCommands(program)
```

Outside paperclip:
- `~/.openclaw/workspace/scripts/creative-workspace/lint.mjs` — added `--json` mode (commit `8e33274` on openclaw `master`)

## Configuration / ENV

| Var | Default | Used by |
|---|---|---|
| `PAPERCLIP_ROUTINE_CHECKS` | unset | boot.ts — must be `"1"` to enable |
| `HERMES_NOTIFY_URL` | `http://127.0.0.1:8765/paperclip/notify` | boot.ts — webhook target |
| `OPENCLAW_WORKSPACE_PREFIX` | `/Users/marco/.openclaw/workspace` | workspace-drift-guard.ts |
| `PAPERCLIP_SHADOW_SYNC_P95` | `"50"` | subscription-shadow-sync.ts (spike = inserts > P95×3) |
| `PAPERCLIP_CREATIVE_ROOT` | `~/.openclaw/workspace/projects/happygang` | creative-lint-nightly, drive-marker-ttl, approved-freshness |
| `PAPERCLIP_CREATIVE_LINT` | `~/.openclaw/workspace/scripts/creative-workspace/lint.mjs` | creative-lint-nightly |
| `DATABASE_URL` | from `readConfig()` | CLI checks.ts |

Secrets file expected (Phase 14 will create):
- `~/.paperclip/secrets/notify-token` (mode 0600, 32-char hex)
- `~/.hermes/secrets/notify-token` (same content)

Without notify-token: paperclip silently disables webhook (logs warning, runs DB-only).

## Known issues / TODOs deferred

1. **Spec doc-drift (LOW):** `docs/specs/...` line 252 mentions lint.mjs path under `~/Code/paperclip/scripts/...` — actually lives under `~/.openclaw/workspace/scripts/...`. Update at convenience.
2. **Schedule TZ adjustment (BLOCKER for cutover, MEDIUM otherwise):** decide UTC-vs-CEST schedules before cutover. See "Schedule semantics caveat" above.
3. **paperclip-server LaunchAgent (BLOCKER for cutover):** Phase 14 requires existing `de.marcoschmid.paperclip-server.plist` with `KeepAlive=true, RunAtLoad=true`. Verify exists before cutover.
4. **CLI test coverage thin (MEDIUM):** boot.test.ts has 2 trivial tests. ENV gate, missing-token warning, interval registration not tested. Below 80% target. Add if pursuing CI strictness.
5. **Subpath export coupling (MEDIUM):** CLI imports `runOne` directly from `@paperclipai/server/routine-checks/runner`. Consider exposing `runCheckByName(db, name)` from `boot.ts` to narrow surface.

## How to resume / verify state

```bash
cd /Users/marco/Code/paperclip
git checkout feat/paperclip-routine-checks
git log --oneline cf3fb751..HEAD          # should be empty (we're at tip)
git log --oneline master..HEAD | wc -l    # 31 commits ahead
cd server && npx vitest run __tests__/routine-checks- __tests__/cron.test.ts
# Expect: 9 + 1 = 10 test files, 93 + 3 = 96 tests pass
cd .. && pnpm --filter @paperclipai/server typecheck
pnpm --filter @paperclipai/cli typecheck
pnpm paperclipai checks list              # smoke, prints 5 checks
```

## Recommended next session order

1. **Phase 12** (Hermes webhook) — independent of paperclip changes, can ship first
2. **Phase 13** (Openclaw heartbeat) — independent, small
3. **Phase 14** (Pre-cutover prep) — verifies LaunchAgent + creates token + snapshots
4. **Phase 15** (Cutover) — pause-not-delete Hermes jobs, enable paperclip via plist
5. **Phase 16** (Verification + cleanup) — 7-day soak then final delete

Or: review/merge `feat/paperclip-routine-checks` to master first (PR), then Phase 12+ as separate branch.
