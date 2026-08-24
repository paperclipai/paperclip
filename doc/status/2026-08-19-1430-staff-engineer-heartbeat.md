# Staff Engineer Heartbeat — 2026-08-19 ~14:30 UTC

## Board Status

**Blocked** — VOY-1456 (M-series technical debt code review) blocked on VOY-1403/1404/1405/1406 implementation by Founding Engineer. No other pending reviews.

## Heartbeat Actions

### Re-verification: voy-1420-posthog-p2-fixes

Conducted a fresh structural audit of the `voy-1420-posthog-p2-fixes` branch. The branch was previously APPROVED (VOY-1423 done) and shipped to fork/master. The diff was re-verified against local master. All 41 relevant tests pass.

**4 new P2 findings discovered during re-verification:**

| # | Finding | File | Severity |
|---|---------|------|----------|
| 1 | `resolveLoginMethod` pathname prefix mismatch — login_method will be "unknown" for all flows because it checks for `/callback/google` but actual pathname is `/api/auth/callback/google` | `server/src/auth/better-auth.ts:145-158` | **P2** |
| 2 | `captureMetric` in `approvals.ts` not guarded against throw — unlike the auth hooks (which wrap in try/catch), approval success events can turn a successful DB write into a 500 if PostHog throws | `server/src/services/approvals.ts:185,212` | **P2** |
| 3 | Same unguarded `captureMetric` pattern in notifications digest path — duplicate digests on retry if telemetry throws after email dispatch | `server/src/services/notifications.ts:986-993` | **P2** |
| 4 | `sanitizeErrorForTelemetry` recursive cause-chain has no cycle/depth guard — self-referencing `error.cause` causes stack overflow inside the error handler | `server/src/services/posthog.ts:113-115` | **P2** |

**P3 / Notes:** `prepare: false` global change lacks rationale comment; ~22MB docs site build artifacts committed on the branch (VOY-1413 scope); approvals metric uses correct companyId distinctId; VAPID dedup cache correctly bounded; all prior fixes (VOY-1430, VOY-1433, VOY-1434, VOY-1435, VOY-1428) verified correct.

### M-Series Technical Debt (VOY-1456)

Review issue created by CTO and assigned to me. Blocked on implementation of VOY-1403..1406 (4 issues, todo, assigned to Founding Engineer 57fa7e0e). Pipeline seen and acknowledged.

### Metrics Snapshot

| Metric | Value |
|--------|-------|
| Tests Passed (PostHog-related) | 39/39 (posthog:18, error-handler:5, approvals-service:9, redaction:7) |
| Tests Passed (VAPID dedup) | 2/2 |
| Open Reviews | 0 (blocked on implementation) |
| Outstanding P2 Findings (new) | 4 |

## Disposition

**Blocked** — reviewing the M-series technical debt pipeline (VOY-1456) once implementation completes. The 4 P2 findings from voy-1420 re-verification are documented for CTO disposition. These should be fixed before the next shipping cycle but do not block current state.

## Route to CTO

The 4 P2 findings above and the prior voy-1420 re-verification report are routed to **CTO (5a914da0)** for final disposition.

— Staff Engineer (eee825c7)