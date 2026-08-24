# Staff Engineer Structural Audit: voy-1420-posthog-p2-fixes

**Reviewer**: Staff Engineer
**Date**: 2026-08-19 ~08:05 UTC
**Branch**: voy-1420-posthog-p2-fixes
**Diff base**: fork/master
**Files changed**: 22 files (+1082/-14)
**Test status**: 32/32 pass (posthog + error-handler + approvals-service)

---

## Previous review follow-up (postaug-pre-stage-2026-08-19.md)

All 7 findings from the pre-stage audit have been addressed:

| # | Severity | Finding | Status | Fix commit |
|---|----------|---------|--------|------------|
| 1 | P1 | Unscrubbed error egress to PostHog (captureException with full stack) | ✅ FIXED | `sanitizeErrorForTelemetry` in posthog.ts redacts message/stack via `redactSensitiveText` before egress |
| 2 | P1 | Constant distinctId "paperclip-server" on business events | ✅ FIXED | approvals.ts uses `updated.companyId`; better-auth.ts uses `user.id`/`session.userId` |
| 3 | P2 | contextSnapshot unsafe cast (heartbeat.ts) | ✅ FIXED | Uses SQL JSON extraction (`->> 'issueId'`) instead of inline cast |
| 4 | P2 | Silent import failure swallowing (3 copies, notifications.ts) | ✅ FIXED | Uses static `import { getTelemetryClient }` instead of dynamic import with catch-swallow |
| 5 | P2 | Approve/reject event shape asymmetry (approvals.ts) | ✅ FIXED | Both paths now capture identical properties |
| 6 | P3 | Digest telemetry fan-out (notifications.ts) | ✅ FIXED | Single `captureMetric` call for the batch |
| 7 | P3 | VAPID warn per-call (notifications.ts) | ✅ FIXED | Bounded FIFO cache with 10K entry cap (VOY-1435) |

**VOY-1433, VOY-1434, VOY-1435** were created as targeted follow-up fixes for the P1/P2 items and have been verified.

---

## New structural findings

### FINDING A — `{ prepare: false }` hard-coded with no rationale (⚠️ P2)

**File**: `packages/db/src/client.ts:50`
**Change**: `postgres(url)` → `postgres(url, { prepare: false })`

Disables *all* prepared statement caching in postgres.js. This is a global change affecting every SQL query in the application.

**Why this matters:**
- Prepared statement caching improves query plan reuse. Disabling it means every query gets a fresh plan parse, which is measurable CPU overhead on hot paths.
- The fork/master version (unchanged) does not use this option — suggesting this is a divergence from the upstream Paperclip codebase. If this is needed for PgBouncer/Neon/Supavisor compatibility, it should be configurable (env var), not hard-coded.
- There is zero documentation: no code comment, no commit message context, no env var. A future reader has no way to tell whether this was intentional or accidental.
- If the deployment uses a direct Postgres connection (no pooler), this is a pure performance regression.

**Recommendation**: Either (a) make this configurable via env var (e.g., `POSTGRES_DISABLE_PREPARE`), or (b) add a code comment explaining which deployment topology requires `prepare: false`. Ideally, match the upstream Paperclip pattern of env-configurable client options that was already designed for this purpose.

---

### FINDING B — Google OAuth: server-side hooks lack unit tests (⚠️ P3)

**File**: `server/src/auth/better-auth.ts`
**Change**: New `databaseHooks` for auth lifecycle + `resolveLoginMethod`

The UI side has tests for Google sign-in button rendering and error handling. The server-side hooks do not:
- `resolveLoginMethod()` URL parsing logic is untested
- `databaseHooks.user.create.after` and `session.create.after` callbacks are untested
- The `try/catch` wrappers around PostHog calls are untested (though the catch path is benign — it logs a warning)

**Risk**: Low — the hooks are wrappers around `captureMetric` with try/catch, so runtime failure mode is a harmless warn log. The URL-parsing logic is simple pathname matching. Not a blocker.

---

### FINDING C — `AS "score"` alias in full-text search (✅ CORRECT)

**Files**: `server/src/services/knowledge-documents.ts:896`, `server/src/services/memory-context-injection.ts:475`
**Change**: Adds `AS "score"` to `ts_rank(...)` computed column

This fixes a bug where the unnamed `ts_rank` expression column would produce undefined/NaN in result rows. Correct fix — without the alias, Drizzle/pg doesn't project a column name for the computed value.

---

### FINDING D — Auth PostHog instrumentation (✅ CORRECT)

**File**: `server/src/auth/better-auth.ts`
**Change**: `auth.signup_completed` and `auth.session_started` events

- Uses `user.id` / `session.userId` as distinctId — correct per-actor analytics
- Captures `login_method` property (google vs email) from request URL pathname
- All calls wrapped in try/catch — telemetry cannot block auth
- Google social provider is only activated when BOTH `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set; warns on partial config — correct defense

---

## Summary

**9 of 9 findings from all audits addressed.** No P0 or P1 issues found in the current diff. One P2 concern (hard-coded `prepare: false`) and one P3 concern (missing server-side auth hook tests).

### Verdict: CONDITIONAL APPROVAL

The branch is structurally sound for shipping. The only item I'd like addressed before promotion to production is Finding A (the `prepare: false` hard-code), which needs either a config env var or a documentation comment. This is P2 — it won't cause incorrect behavior, but it's a maintenance trap and potential performance footgun.

**Gate**: Add env-var configuration or comment for `prepare: false` before production promotion. The P3 (auth hook tests) is a should-have, not a blocker.

Routing to CTO for go/no-go decision.
