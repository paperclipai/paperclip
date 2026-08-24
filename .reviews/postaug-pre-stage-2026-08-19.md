# Structural Audit: PostHog Pre-Stage Instrumentation (VOY-1029 Phase A)

**Reviewer**: Staff Engineer
**Date**: 2026-08-19
**Commit**: c542464362 (core) + uncommitted working-tree call sites
**Diff**: 17 files, +274/-28 lines

---

## Verdict: CONDITIONAL APPROVAL — 2 P1 issues must be fixed before shipping

Tests pass (16/16 posthog, 15/15 shared), but passing tests do not mean the branch is safe. Three structural issues survive CI.

---

## P1 — Unscrubbed error egress to PostHog (trust boundary violation)

**Files**: `server/src/middleware/error-handler.ts` (committed), `server/src/services/posthog.ts` (committed)
**Commit**: c542464362

The error handler calls `captureErrorEvent(rootError, ...)` on every 500-level error. This calls PostHog's `captureException` which serializes the full error object — name, message, AND stack trace — to a third-party SaaS (posthog.com cloud). The same error path uses `trackErrorHandlerCrash` for first-party Paperclip telemetry, which deliberately sends only the error code — minimal.

### Why this is a problem

Error stacks can embed PII and secrets:
- SQL constraint violations containing user emails ("duplicate key value violates unique constraint 'users_email_key' — Key (email)=(jane@example.com)")
- File paths revealing internal directory structure
- Wrapped connection strings or API tokens in error messages
- Request payloads echoed back in validation errors

The PostHog host is already provisioned on vps-1 (per commit message). This is a live egress path.

### Fix

Apply `redactSensitive()` (already imported in the logger middleware) to the error message and stack before passing to `captureException`, or limit PostHog error events to the error code only (matching the first-party telemetry pattern). Alternatively, gate `captureErrorEvent` behind a separate opt-in flag.

---

## P1 — Constant distinctId "paperclip-server" on all business events

**Files**: `server/src/routes/approvals.ts`, `server/src/routes/issues.ts` (uncommitted)

`captureMetric("review.decision", undefined, {...})` and `captureMetric("issue.created", undefined, ...)` / `captureMetric("issue.completed", undefined, ...)` all use the default distinctId "paperclip-server". Every approval decision, issue creation, and issue completion from every company and every actor collapses into a single anonymous user in PostHog.

### Why this is a problem

PostHog analytics are fundamentally user-centric. With a constant distinctId:
- Per-company funnel analysis is impossible
- Per-actor agent-vs-user breakdown doesn't work
- All events carry companyId in properties, so raw-event export is salvageable, but dashboards, insight, and retention views are garbage
- The "paperclip-server" pseudo-user accumulates all events, polluting the user table

Compare with heartbeat.ts which correctly uses `run.agentId` as distinctId — inconsistent with the rest of the instrumentation.

### Fix

Use `companyId` as the distinctId and place agent/user identity in event properties. E.g.:
```ts
captureMetric("issue.created", companyId, { createdByAgentId: ..., actorType: ... })
```

---

## P2 — contextSnapshot type-unsafe cast (heartbeat.ts)

**Files**: `server/src/services/heartbeat.ts` (uncommitted, lines 6223-6225 and 6247-6249)

```ts
typeof run.contextSnapshot === "object" && run.contextSnapshot !== null
  ? (run.contextSnapshot as Record<string, unknown>).issueId ?? null
  : null
```

The codebase already has `readStringFromRecord` (issues.ts:213) which handles both object and string-typed snapshots defensively. The new code re-implements a less robust version. While JSONB columns return parsed objects from the pg driver, the existing pattern exists for a reason — defensive coding against edge cases. The cast duplicates logic and is slightly less robust than the helper.

**Fix**: Use `readStringFromRecord(run.contextSnapshot, "issueId")` instead of the inline cast.

---

## P2 — Silent import failure swallowing (3 copies)

**Files**: `server/src/services/notifications.ts` (uncommitted)

Three places use:
```ts
const telemetry = await (async () => {
  try {
    const { getTelemetryClient } = await import("../telemetry.js");
    return getTelemetryClient();
  } catch {
    return null;
  }
})();
```

The `catch { return null }` swallows ALL errors — including real import failures (syntax errors, circular deps, missing modules). A genuine bug in telemetry.js would silently degrade to no-op instead of failing loudly. The static import was removed for reasons that are not obvious — telemetry.ts does not import notifications, so there's no cycle to break.

**Fix**: At minimum, log a warning on failure. Better: keep the static import and use a try/catch around only the `getTelemetryClient()` call.

---

## P2 — Approve/reject event shape asymmetry

**Files**: `server/src/routes/approvals.ts` (uncommitted)

The approve path captures `issueIds`, `primaryIssueId`, `requestedByAgentId`; the reject path captures none of these. For funnel analysis (which approvals get rejected, and on what issues), the reject event is missing the joining keys.

**Fix**: Capture the same `issueIds`/`primaryIssueId`/`requestedByAgentId` properties on reject events.

---

## P3 — Digest telemetry fan-out

**Files**: `server/src/services/notifications.ts` (uncommitted)

```ts
for (const n of pending) {
  trackNotificationDeliverySent(digestTelemetry, { channel: "email", ... });
}
```

Fires one telemetry event per notification in the digest batch. With limit 50, that's up to 50 events per digest run. Not a correctness issue, but wasteful for large volumes.

**Fix**: Batch the telemetry or emit a single event with a count.

---

## P3 — VAPID warning per-call (log spam)

**Files**: `server/src/services/notifications.ts` (uncommitted)

`sendWebPush` now logs `logger.warn("VAPID not configured; skipping web push...")` on EVERY notification attempt when VAPID is missing. If webpush is an enabled channel but VAPID isn't configured, this spams the log at warn level.

**Fix**: Gate behind a one-time flag or log at debug level after the first warning.

---

## DEPLOYED — TDZ bug fix (positive finding)

**Files**: `server/src/services/notifications.ts` (uncommitted)

The old code referenced `emailDeferredToDigest` in the initUpdates block BEFORE its `let` declaration — a Temporal Dead Zone ReferenceError that would crash `notify()` whenever email was an active channel. The reorder (computing deferral before init) is the correct fix. This is a legitimate bug that was silently passing tests because the email channel was never exercised in the test suite.

**Tests pass, but the real failure mode was a crash in production**. Good catch by the implementer.

---

## Summary

| # | Severity | Finding | File | Status |
|---|----------|---------|------|--------|
| 1 | P1 | Unscrubbed error egress to PostHog (captureException with full stack) | error-handler.ts | COMMITTED |
| 2 | P1 | Constant distinctId "paperclip-server" on business events | approvals.ts, issues.ts | UNCOMMITTED |
| 3 | P2 | contextSnapshot unsafe cast (use readStringFromRecord) | heartbeat.ts | UNCOMMITTED |
| 4 | P2 | Silent import failure swallowing (3 copies) | notifications.ts | UNCOMMITTED |
| 5 | P2 | Approve/reject event shape asymmetry | approvals.ts | UNCOMMITTED |
| 6 | P3 | Digest telemetry fan-out (50 events per digest) | notifications.ts | UNCOMMITTED |
| 7 | P3 | VAPID warn per-call (log spam) | notifications.ts | UNCOMMITTED |
| 8 | ✓ | TDZ bug fix (emailDeferredToDigest ordering) | notifications.ts | UNCOMMITTED |

The core PostHog service (posthog.ts) and tests are solid. The call-site instrumentation is well-intentioned but has data-modeling issues that will poison analytics (constant distinctId) and a trust-boundary violation (unscrubbed error stacks to third-party SaaS). The notifications.ts reorder is a legitimate bug fix that was masked by test coverage gaps.

**Gate**: Fix P1 items before shipping. The P2 items are recommended fixes before Phase B deployment.