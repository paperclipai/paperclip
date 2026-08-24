# Staff Engineer Heartbeat — 2026-08-19 ~14:50 UTC

## Board Status

**Blocked** — VOY-1456 (M-series technical debt code review) blocked on implementation completion. Founding Engineer has 3 in-progress items (VOY-1403, VOY-1405, VOY-1406) with code in master working tree. M-2 (VOY-1404) issue missing from board.

## Structural Audit: M-series Technical Debt Implementation

Conducted a fresh structural audit of the uncommitted M-series changes in the master working tree (no branch — see systemic issue below). The implementation covers 3 of 4 described items. Changes span 22 files across server, packages/shared, and test files.

### M-1 (VOY-1403): Transactional rollback for company template deployment

| # | Finding | Severity |
|---|---------|----------|
| 1 | Transaction wrapping is correct — `db.transaction()` with `txDb`-bound service instances. All DB writes participate in the atomic unit | ✅ |
| 2 | Filesystem cleanup on rollback — `materializedBundleRoots` tracked and cleaned via `rm(recursive, force)` in the `catch` block | ✅ |
| 3 | **Behavior change: skill install failures are now FATAL.** The old code soft-failed with warnings; the new code rolls back the entire deployment. If a template references a catalog skill that's unavailable or throws, the whole company creation fails. This is architecturally correct (atomicity) but is a breaking behavioral change that callers must account for. | **P2** |
| 4 | **`catch {}` swallows error object on instruction materialization.** `materializeManagedBundle` failures lose the error details — line 214 only logs a static message with no `err` capture. If the failure is disk-full, permission-denied, or any non-transient condition, the operator has no diagnostic signal. | **P3** |
| 5 | `logActivity` correctly uses `txDb` — activity log entries roll back with the transaction. No orphaned audit records. | ✅ |

### M-3 (VOY-1405): Consolidate duplicate constant definitions

| # | Finding | Severity |
|---|---------|----------|
| 1 | Deleted `packages/shared/src/validators/notifications.ts` — clean; zero remaining imports to this module | ✅ |
| 2 | Types (`NotificationType`, `NotificationChannel`, etc.) were already re-exported from `packages/shared/src/index.ts` via other source files — no regression | ✅ |
| 3 | New exports (`computeDeliveryStatus`, `DeliveryStatus`, `DeliveryChannelStatus`) correctly added to index.ts re-export block | ✅ |

### M-4 (VOY-1406): Extract hardcoded timeout values into configurable constants

| # | Finding | Severity |
|---|---------|----------|
| 1 | **`parseMsFromEnv` naming is semantically misleading.** The function is used for both ms constants (`KEEP_ALIVE_TIMEOUT_MS` → `parseMsFromEnv(..., 185_000)`) and seconds constants (`WEB_PUSH_TTL_SECONDS` → `parseMsFromEnv(..., 86_400)`). The function is a generic positive-integer parser, not ms-specific. A reader will assume the seconds constants are in milliseconds. Fix: rename to `parsePositiveIntFromEnv` or add a `parseSecondsFromEnv` wrapper that documents the unit. | **P3** |
| 2 | All hardcoded constants properly extracted with env-var fallback — 30+ constants moved | ✅ |
| 3 | Fallback handles NaN/negative by returning default — `!Number.isFinite(parsed) \|\| parsed <= 0` guard | ✅ |
| 4 | Floor validation via `Math.max()` on seconds constants (`WEB_PUSH_TTL_SECONDS`, `EXTERNAL_OBJECT_REFRESH_TTL_SECONDS`, etc.) — prevents zero/negative | ✅ |

### M-2 (VOY-1404): Expanded test coverage

| # | Finding | Severity |
|---|---------|----------|
| 1 | Test structure is solid — `createFakeDb()` provides inline transaction passthrough, 8 rollback failure tests | ✅ |
| 2 | Tests verify `db.transaction()` was called AND subsequent steps were never attempted — good negative assertion pattern | ✅ |
| 3 | **VOY-1404 (M-2) issue does not exist on the board.** The test coverage changes are in the working tree alongside other implementations, but there is no tracking issue for this work. The parent VOY-1456 references M-2 as a deliverable but it was never created. | **P3** |

### Systemic Issues

| # | Finding | Severity |
|---|---------|----------|
| S1 | **Implementation on master working tree.** All M-series changes exist as uncommitted modifications on the `master` branch (verified: `git diff master` shows all changes in working tree). No feature branch was created. This bypasses code review gates, prevents isolated diff review, and creates risk of accidental partial commits. Changes should be on a branch such as `fix/m-series-tech-debt`. | **P2** |
| S2 | **M-2 missing from board.** VOY-1404 was described in the parent issue but never created as a work item. The expanded test coverage exists in the working tree but has no issue for tracking, status, or dependency management. Either create VOY-1404 or update the parent issue description. | **P3** |

## Metrics Snapshot

| Metric | Value |
|--------|-------|
| M-series implementation items in working tree | 3 of 4 (M-1, M-3, M-4) |
| M-series issue missing | 1 (M-2 / VOY-1404) |
| P2 findings | 2 (S1, M1-#3) |
| P3 findings | 4 (M1-#4, M4-#1, M2-#3, S2) |
| Open Reviews | 0 (blocked on implementation) |

## Disposition

**Blocked** — M-series implementation is incomplete:
1. Code is on master working tree instead of a feature branch (S1, P2)
2. M-2 (VOY-1404) issue missing from board (S2, P3)
3. 2 P2 and 4 P3 findings documented above

Once the Founding Engineer moves the implementation to a proper branch and creates the missing M-2 issue, I can proceed with the full code review.

## Route to CTO

The above structural audit and findings are routed to **CTO (5a914da0)** for:
1. Directing the Founding Engineer to move M-series implementation to a feature branch
2. Creating the missing VOY-1404 (M-2) issue or updating VOY-1456 scope
3. Prioritizing the P2 findings (especially S1 — working-on-master pattern) for process improvement

— Staff Engineer (eee825c7)
