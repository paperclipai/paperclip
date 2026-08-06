# TSMC-19799 — fallback-monitor cancelled-card reopener

## Verdict

**Reopener identified and gated.** Cancelled duplicate rails no longer un-cancel in place.

## 1. Reopener (audit)

Smoking-gun `routine_runs` rows on 2026-08-05 (UTC):

| company | run status | utc | linked issue | issue status now |
|---------|------------|-----|--------------|------------------|
| TSB | issue_reused | 14:58:23 | TSB-4601 | cancelled |
| TSM | issue_reused | 15:07:23 | TSM-3204 | cancelled |
| **DP** | **issue_reused** | **15:08:23** | **DP-3747** | cancelled |
| TSR | issue_reused | 15:11:26 | TSR-3636 | cancelled |
| TSB | issue_reused | 15:13:24 | TSB-4594 | cancelled |

Exact match to the board observation (`DP-3747` → open again at `15:08:23`).

### Mechanism

- Per-company routine `fallback-monitor` is **active** with:
  - `concurrency_policy = skip_if_active`
  - `env.PAPERCLIP_ROUTINE_ISSUE_MODE = reuse_terminal`
- On schedule fire, `routineService` called `findReusableTerminalExecutionIssue` (includes `cancelled` + `done`) and then `issueSvc.update(..., status: "todo")`.
- That path **un-cancelled in place** (`cancelledAt` cleared) — not a new row.
- Actor class: **system scheduler / routine dispatch**, not a board user and not an agent heartbeat comment.

Code path (served tree `/Users/glad0s/paperclip-deploy`, also in `/Users/glad0s/paperclip` `live`):

- `server/src/services/routines.ts` — `canReuseTerminalExecutionIssue` + terminal reuse block
- Generator env: `PAPERCLIP_ROUTINE_ISSUE_MODE=reuse_terminal` on all live FM routines (DP/TSB/TSM/TSR/TSC/TSK/TSMC)

## 2. Terminal states stay terminal (cancelled)

Commit `d2a5b6998` (`fix(routines): preserve cancelled executions`, 2026-08-05 16:37 +0100):

- If reusable terminal issue is `cancelled`, do **not** `update` it to `todo`.
- Keep it cancelled; create a **new** execution card whose description cites  
  `Replacement for cancelled routine execution <identifier>.`
- `done` reuse remains intentional for normal schedule cadence of the keeper rail.

Deployed: receipt `e8929d919…` includes ancestor `d2a5b6998` / `f0fcec16c`. Live server cwd = `paperclip-deploy`.

## 3. Dedupe at creation

Same commit + schema:

- Partial unique index `issues_open_fallback_monitor_execution_uq`  
  `(company_id, normalized title)` where open + `origin_kind=routine_execution` + title `fallback-monitor`
- Migration `packages/db/src/migrations/0200_fallback_monitor_terminal_guard.sql` — **present in live DB**
- Service create path: for FM routine executions, `allowDuplicate: false` + title-keyed advisory lock / coalesce (`issues.ts` + `routines.ts`)
- Ordering fix `f0fcec16c` moved `isFallbackMonitorExecution` below `title` (TDZ / fleet outage risk)

## 4. Live fleet state after fix (measured 2026-08-06)

Open non-hidden `fallback-monitor` cards:

| prefix | open_n | keeper |
|--------|--------|--------|
| DP | 0 | (schedule reuses done keeper DP-3852) |
| TSB | 0 | TSB-4603 done |
| TSM | 0 | TSM-5441 done |
| TSR | 0 | TSR-4193 done |
| TSMC | 1 | TSMC-19360 todo |
| TSC/TSK | 0 | done keepers |

No multi-open duplicate rails. Cancelled dups from the Aug 5 wave (e.g. DP-3747/3745/3748) remain `cancelled` with stable `cancelled_at`.

Recent schedule runs show `issue_reused` only against the intended **done/open keeper** path (e.g. TSMC-19360), not against cancelled duplicates.

## 5. Verification

```text
pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/routines-service.test.ts \
  -t "keeps a cancelled scheduled execution terminal|coalesces a duplicate fallback-monitor"
# → 2 passed
```

Test fixture repair in this closeout:

- Coalesce test used invalid `blocked` create (no blockers) and `svc.run` (missing API).
- Fixed to `todo` + foreign `originId` + `runRoutine` + `and` import so the title-keyed create-dedupe path is actually exercised.

## 6. Recurrence layer

| layer | encoding |
|-------|----------|
| Platform service | `routines.ts` skips cancelled terminal reuse |
| DB guard | `issues_open_fallback_monitor_execution_uq` |
| Create-time coalesce | `allowDuplicate: false` for FM title |
| Test | cancelled→replacement + FM coalesce cases |

## Out of scope / related

- Fleet-wide sister registration audit remains on **TSMC-19767**
- `done` reuse for FM keepers is still by design under `reuse_terminal` (creates the 15-min heartbeat cadence on one stable identifier per company)
- No new TSKB claim required beyond this work product; process already captured in code comments + this artifact

## Disposition

**done** — reopener named, cancelled terminal preserved, create-time dedupe live, focused tests green, fleet open count ≤1 per company.
