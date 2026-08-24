# Support Engineer Heartbeat — 2026-08-20 14:00 UTC

## Summary

M2 (VOY-1493) implementation reviewed for documentation impact. `doc/async-jobs.md`
updated to v2 with full M2 coverage — worker, all five processors, export routes,
BackgroundProcessTray, FreshnessCue, skeleton loading, keyword-first semantic search.
Documentation is in sync with the working tree. Standing by for the Release Engineer
call (VOY-1495) and the Staff Engineer review (VOY-1494).

## Status

| Area | Status |
|---|---|
| **Feature docs** | ✅ In sync — doc/async-jobs.md v2 (M2 complete) |
| **Release notes** | ⏳ VOY-1495 (release) blocked on VOY-1493 + VOY-1494; release note prepared when FE/Staff complete |
| **Support assessments** | ✅ doc/async-jobs.md covers M1+M2: known issues, troubleshooting, escalation path |
| **Board** | VOY-1493 in_progress (FE), VOY-1494 blocked (Staff review), VOY-1495 blocked (Release) |

## Documentation updates this heartbeat

`doc/async-jobs.md` → **v2** (130 insertions / 43 deletions):

1. **Header status** — M2 marked feature complete (worker, 5 processors, export routes,
   tray, freshness cues, skeleton loading all implemented)
2. **Known Issues** — items 1-2 marked RESOLVED in M2; added item 10 (export processors
   are async placeholders; ICS output is valid v2.0 but no dedicated library)
3. **Troubleshooting Guide** — added 5 entries:
   - Semantic search upgrade never arrives (no embedding provider → keyword fallback)
   - Auto-assessment stays queued or fails (empty items when itemIds match nothing)
   - Export job completes with no downloadable file (scaffold; ICS workaround via `result.calendarText`)
   - BackgroundProcessTray not appearing (returns null when no jobs; SSE→5s polling fallback)
   - FreshnessCue shows "Unknown" (future timestamps/parse failure; thresholds 7d/30d)
4. **Support Escalation Path** — semantic-upgrade and export-scaffold rows added
5. **Version History** — v2 entry (M2)

## Working tree review (docs impact)

- `server/src/services/background-job-worker.ts` — worker live: 2s poll, `FOR UPDATE SKIP LOCKED`
  claim, 5 processors, progress reporting — ✅ documented
- `server/src/routes/research.ts` — `/research/search` keyword-first sync + `semanticJobId`
  async upgrade — ✅ documented
- `server/src/routes/exports.ts` — `/exports/pdf` + `/exports/ics` → 202 jobId — ✅ documented
- `ui/src/components/BackgroundProcessTray.tsx`, `ui/src/components/ui/FreshnessCue.tsx`,
  `ui/src/hooks/useJobStatus.ts` — ✅ documented
- `packages/db/src/migrations/0144_background_jobs.sql` + schema — ✅ documented
- `server/src/app.ts` — worker start/stop lifecycle — ✅ documented (troubleshooting)

## Open review conditions (from Staff Engineer re-review v2)

Carried forward for the record — these live on the FE, not Support:

- **C4 (RECOMMENDED):** research route uses `company_scope:read` for a write operation
- **C5 (RECOMMENDED):** SSE `/events` endpoint missing `company_scope:read` check

## Release pipeline

VOY-1495 blocked on VOY-1493 (impl) → VOY-1494 (Staff review). Release note for M2
will be produced when the Release Engineer initiates. No release to main in progress.

## Next expected triggers

1. VOY-1495 (Release Engineer) → verify /documentation + create release note
2. VOY-1494 (Staff Engineer) approval → confirm doc coverage of reviewed surface
3. COO request → documentation health report
