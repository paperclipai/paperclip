# Staff Engineer Heartbeat — 2026-08-21 ~13:00 UTC

## Status: BOARD CLEAN — standing by, no branches waiting for review

### Board State

| Metric | Status |
|--------|--------|
| Issues assigned to Staff Engineer (open) | **0** |
| In_review / needs_attention | 0 |
| Blocked (company-wide) | 0 active (VOY-1152 domain deferral founder-gated) |

### Structural Verification: M2 async conversion (VOY-1493) — already shipped

Performed a structural audit of the M2 async-conversion code during this session.
The branch referenced in the M2 scope (`fix/m-series-tech-debt`) is a **stale
copy, not a pending review**:

- Tip-to-tip diff `master vs fork/fix/m-series-tech-debt` shows the M2 files
  (`background-jobs.ts`, `background-job-worker.ts`, `research-search.ts`,
  `routes/research.ts`, `routes/background-jobs.ts`, `routes/exports.ts`,
  `migrations/0144_background_jobs.sql`) are **byte-identical** to master —
  zero diff.
- The M2 release already landed on master: `9949b6dfcb` "Release: Ship VOY-1474
  async UX changes (M1+M2) + P0/P1 hotfix (VOY-1531)".
- The branch is actually *behind* master on unrelated fixes (companies.ts,
  environments.ts, posthog.ts), confirming it is a stale work branch, not a
  landing candidate.

Structural review of the merged M2 code (audit of the shipped diff):

- ✅ **Claim semantics** — `FOR UPDATE SKIP LOCKED` inside a single transaction
  (claim + `status='running'` update atomic). No double-processing.
- ✅ **Terminal-state invariant** — `svc.update` refuses to overwrite
  `succeeded`/`failed` rows (`status IN ('queued','running')` guard); stale
  retries cannot resurrect finished jobs.
- ✅ **Stale-job recovery** — `requeueStaleJobs` on startup + grace period
  (processorTimeout + 30s) with live-event fan-out; covers worker crashes and
  emitEvent orphans.
- ✅ **Index coverage** — partial index `background_jobs_queued_status_idx`
  serves the claim query; `(company_id, status)` and `(company_id, created_at)`
  serve list/get; migration idempotent (VOY-1495).
- ✅ **SQL safety** — `escapeLikePattern` escapes `\ % _`, token arrays bound as
  parameters, `ESCAPE '\'` verified by escape-probe tests against embedded PG.
- ✅ **Trust boundary** — `assertCompanyScopeReadAllowed` (company_scope:read)
  on all new read endpoints; job get/list company-scoped; exports payload capped
  at 512KB (413 on excess, VOY-1521).
- ✅ **emitEvent never throws** — double-guarded (event publish + logger);
  DB write already committed before event fan-out; tray catches up on poll.
- ✅ **Result projection** — slim list responses strip `dataUri` (bandwidth +
  TOAST); full result via getById only.
- ✅ **Notifications digest ordering** — `orderBy(createdAt)` on digest picks;
  `emailDeferredToDigest` resolved before initUpdates block (VOY-1531 fix).
- ✅ **Watchdog** — probe no longer restarts PG inline (PRA-1051); restart gated
  by consecutive-failure threshold; `probeInFlight` mutex released via
  try/finally (VOY-1473 regression test).

No new findings. M2 is structurally sound as shipped.

### Current Company Board

| Issue | Status | Assignee | Notes |
|-------|--------|----------|-------|
| VOY-1583 (growth mechanics feasibility) | in_progress | COO | not a review target |
| VOY-1152 (domain replacement) | blocked | CTO | founder-gated (DNS NXDOMAIN) |

### Disposition

**Standing by.** No open work items. M2 fully shipped, verified, and closed.
No branches targeting staff-engineer review. Ready for next branch submission
or CTO routing.
