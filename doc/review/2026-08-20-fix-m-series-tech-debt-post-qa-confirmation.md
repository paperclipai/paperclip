# Staff Engineer — Post-QA Structural Confirmation (VOY-1535)

**Date:** 2026-08-20 ~20:35 UTC
**Scope:** Independent code-level verification of the M2 post-ship P0/P1 hotfix (VOY-1527/1531), supplementing QA Engineer's live production evidence on VOY-1535.
**Result:** ALL 4 ITEMS CONFIRMED at code level. QA PASS chain complete.

---

## Verification matrix

| # | Finding | Fix in code | Code evidence | QA live evidence (VOY-1535) |
|---|---------|-------------|---------------|------------------------------|
| 1 | emitEvent can throw after DB commit → duplicate execution on retry (P0) | `emitEvent()` wrapped in try/catch; `create()`/`update()` guard the emit call so DB write always wins | `server/src/services/background-jobs.ts:52-54` (emitEvent wrapper), `:99` (create catch), `:159` (update catch) | New job created → succeeded in 51ms; no job stuck by SSE failure |
| 1b | `update()` can overwrite terminal status (P0, same invariant) | `update()` WHERE clause restricts to `status IN ('queued','running')` — terminal statuses are immutable | `server/src/services/background-jobs.ts:148-152` (`inArray(backgroundJobs.status, ["queued","running"])`) | Regression guard confirmed in QA report |
| 2 | No stale-'running' recovery after crash → eternal spinner (P0) | `requeueStaleJobs()` resets jobs stuck in 'running' > processorTimeoutMs + 30s to 'queued'; called on worker startup | `server/src/services/background-job-worker.ts:349` (function), `:423` (call at start) | Injected stale-running job → restart → requeued → succeeded (progress 100) |
| 3 | Large binary PDF/ICS results in DB; list endpoint returns unbounded payloads (P1) | `toApi(row, slim)` strips `result.dataUri` from list/tray responses; `getById` returns full result | `server/src/services/background-jobs.ts:27-32` | 4 export.pdf jobs: dataUri absent in list, present in getById |
| 4 | `emailDeferredToDigest` ordering → digest-deferred email shows 'pending' (P1) | Digest preference query moved BEFORE the initUpdates block that sets `emailDeliveryStatus='pending'`; documentation comment added | `server/src/services/notifications.ts:573-590` (query before guard), `:594` (guard now reflects digest state), `:569-572` (comment explaining prior bug) | Digest-deferred notifications have `emailDeliveryStatus=null` (not 'pending') |

## Structural notes

- The status guard in `update()` (finding 1b) closes the duplicate-execution cascade end-to-end: even if a retry loop re-enters, it cannot flip a committed `succeeded`/`failed` row. This was the root of the P0 in the M2 re-review.
- The stale-job recovery uses the existing `startedAt` column (set during the claim transaction) — no schema change needed; threshold = `processorTimeoutMs + 30s` grace. Sound.
- Result projection is a read-path fix; writes still store the full base64 data-URI. The code comment (worker.ts:159-161) still references the future blob-storage path — acceptable documented tradeoff for now, tracked as P2 backlog.
- No new issues introduced by the hotfix commit range (`dd2a41f9a0` → `9949b6dfcb`); diff is confined to the four fix sites plus the lockfile/type-declaration CI unblocks.

## Disposition

- **VOY-1535** (QA Verification): PASS — owned by QA Engineer; routed to CTO via `request_confirmation` (interaction `7bb6e6e0-...`, pending). This issue is outside my authz boundary (403 on comment), which is correct — the QA Engineer owns the disposition.
- **Staff Engineer board:** No open work items. M-series complete end-to-end (VOY-1470 audit → VOY-1493 M2 → VOY-1527 post-ship audit → VOY-1531 hotfix → VOY-1533 review → VOY-1534 release → VOY-1535 QA PASS).
- **Standing by** for the next branch submission or CTO routing.

## P2 backlog (documented acceptance, next cycle)

1. `tick()` in-flight race can exceed `batchSize` concurrency — pre-reserve capacity before the await (`background-job-worker.ts`)
2. Missing test coverage for retry / timeout / emit-failure failure paths
3. Arbitrary `jobType` accepted by create routes — validate against `BACKGROUND_JOB_TYPES` at the boundary
4. Result blob storage (S3) to replace base64-in-DB for large exports
