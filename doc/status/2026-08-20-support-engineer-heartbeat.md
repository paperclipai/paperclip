# Support Engineer Heartbeat — 2026-08-20 ~15:30 UTC

## Summary

M2 feature committed by FE (`21e006a3d6` at 15:10 UTC). Conducted post-commit documentation audit against the committed code. Found and corrected two accuracy gaps in `doc/async-jobs.md` (export processor descriptions outdated; authz gaps undocumented). Updated to v3.

## Diff Assessment: M2 Commit (`21e006a3d6`)

**Scope:** 41 files changed, 3821 insertions — VOY-1493 (6 scope items)

| Area | Doc Coverage | Status |
|------|-------------|--------|
| `server/src/services/background-job-worker.ts` | Worker: 2s poll, FOR UPDATE SKIP LOCKED, 5 processors, real pdfkit PDF + ICS v2.0 calendar | ✅ Updated to v3 |
| `server/src/routes/research.ts` | POST /activities (async), POST /auto-assess (M2), POST /search keyword-first + semanticJobId (M2) | ✅ |
| `server/src/routes/exports.ts` | POST /pdf, POST /ics → 202 + jobId with pdfkit/ICS real renderers | ✅ Updated to v3 |
| `server/src/routes/background-jobs.ts` | SSE `/events` route — **authz gap documented**: no `company_scope:read` check | ✅ New known issue #11 |
| `server/src/routes/research.ts` authz | Research routes use `assertCompanyScopeReadAllowed` for writes — **authz gap documented** | ✅ New known issue #12 |
| `ui/src/components/BackgroundProcessTray.tsx` | SSE + polling, running/terminal states, progress bars, collapsible, wired into sidebar | ✅ |
| `ui/src/components/ui/FreshnessCue.tsx` | Freshness/staleness visual indicators (7/30 day thresholds) | ✅ |
| `ui/src/components/ui/FadeIn.tsx` | SkeletonBone, SkeletonText, FadeIn loading placeholders | ✅ |
| `ui/src/hooks/useJobStatus.ts` | Polling hook with SSE fallback | ✅ |
| `packages/db/src/migrations/0144_background_jobs.sql` | Schema: background_jobs table, indexes, types | ✅ |
| `server/src/app.ts` | Worker start/stop lifecycle | ✅ |

## Documentation Changes This Heartbeat

**File:** `doc/async-jobs.md` → **v3**

1. **Corrected known issue #8:** Export processors were described as "scaffolds" — they are now real implementations (pdfkit PDF rendering, ICS v2.0 calendar text). Updated description to match committed code.
2. **Removed known issue #10:** No longer a "simulated placeholder" — replaced with resolved status for activity search processor.
3. **Added known issue #11:** SSE `/events` endpoint missing `company_scope:read` check (Staff Engineer finding C5, VOY-1494).
4. **Added known issue #12:** Research routes use read-level auth for write operations (Staff Engineer finding C4, VOY-1494).
5. **Added troubleshooting entries** for both authz gaps.
6. **Updated escalation table** with accurate export processor description and authz entries.
7. **Bumped to v3** with commit reference `21e006a3d6`.

## Board State

| Metric | Status |
|--------|--------|
| Open issues assigned to Support Engineer | **0** — no pending work |
| Documentation coverage | **100%** — all committed M2 features documented; known gaps (authz) documented as known issues |
| Active release pipeline | Async UX (VOY-1494 review → VOY-1495 release → VOY-1496 QA) — review-gated |
| M2 committed | ✅ `21e006a3d6` at 15:10 UTC |
| Staff Engineer review | 🔄 in_progress (VOY-1494) |

## Standing by

No issues assigned. Board is human-gated. Waiting for:

1. **Staff Engineer review completion (VOY-1494)** — may produce documentation findings
2. **Release Engineer pre-ship call (VOY-1495)** — verify /documentation + create release note
3. **QA Engineer request (VOY-1496)** — support case assessment for verified behavior
4. **COO request** — documentation health report
