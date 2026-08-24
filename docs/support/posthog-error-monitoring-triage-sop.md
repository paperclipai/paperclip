---
title: PostHog Monitoring — Support Engineer Triage SOP
summary: SOP for triaging PostHog error issues and business events (VOY-999 / VOY-1420)
status: final
applies_to: VOY-999 / VOY-1007 / VOY-1015 / VOY-1029 / VOY-1420 / VOY-1428 / VOY-1430 / VOY-1456 (P2-1)
---

# PostHog Monitoring — Support Engineer Triage SOP

**Version:** 1.6.0
**Date:** 2026-08-20
**Author:** Support Engineer (88b72065)
**Status:** Final — Sanitization now operates on a clone of the error (P2-1 / b6c96c2f55); original error objects are never mutated. v1.5.0's in-place-mutation description superseded.
**Applies to:** VOY-999 / VOY-1007 / VOY-1015 / VOY-1029 / VOY-1420 / VOY-1428 / VOY-1430 / VOY-1456 (P2-1)

---

## Overview

PostHog serves two roles in the Voyonder platform:

1. **Error monitoring** — Auto-creates Paperclip issues for production errors captured by PostHog and assigns them to the Support Engineer (agent 88b72065).
2. **Business event telemetry** — Tracks key product events (approvals, notification digests) using `captureMetric()` with company-level distinct IDs.

This SOP defines how to triage, classify, and resolve issues in both categories.

---

## How It Works

1. **Error capture:** The Voyonder frontend and backend call `trackErrorOccurred()` (lib/analytics.ts) / `trackErrorOccurredServer()` (lib/analytics-server.ts) with error details → PostHog. **PII redaction is applied server-side** before errors reach PostHog — the `sanitizeErrorForTelemetry()` function clones the error (message, stack, cause, custom properties), redacts the clone's `message` and `stack` via `redactSensitiveText()`, then recursively redacts the `cause` chain. The **original error object is never modified** — any code reading the original after the call sees the unredacted values. The stack trace is preserved (with file paths and tokens redacted), enabling triage by throw site. (See [Stack Trace Handling](#stack-trace-handling).)
2. **Cron poll:** `scripts/posthog-error-monitor.sh` runs every 15 minutes via crontab on VPS-1, queries PostHog for new error_occurred events since last check
3. **Issue creation:** For each unique error signature (grouped by event+component+normalized message), a Paperclip issue is created:
   - **Title:** `[PostHog] {event}: {component} — {truncated message}`
   - **Priority:** Mapped from severity (critical→urgent, high→high, medium→medium, else→low)
   - **Assignee:** Support Engineer (88b72065)
   - **Parent:** VOY-999
   - **Body:** Event details with component, severity, URL, message, occurrences, affected users
4. **Deduplication:** Error signatures are normalized (UUIDs, timestamps, UNIX timestamps stripped) and cooldown prevents re-alerting on the same signature within 60 minutes
5. **State file:** `/var/tmp/posthog_monitor_last_check` tracks the last successful poll
6. **Pending retry:** If Paperclip API is unreachable, issue payloads are saved to `/var/tmp/posthog_pending/` and retried on the next run

---

## Business Events

Business events are sent to PostHog via `captureMetric()` to track key product operations. Unlike error events, these are **not** auto-created as Paperclip issues — they are telemetry data used for dashboards, analytics, and debugging.

### Instrumented Events

| Event Name | Source | Trigger | distinctId | Properties |
|---|---|---|---|---|
| `approval.approved` | `services/approvals.ts` | An approval (hire, strategy, plan gate) is approved | `companyId` | `approvalId`, `approvalType`, `decidedByUserId`, `applied`, `decisionNote` |
| `approval.rejected` | `services/approvals.ts` | An approval is rejected | `companyId` | `approvalId`, `approvalType`, `decidedByUserId`, `applied`, `decisionNote` |
| `notification.digest.sent` | `services/notifications.ts` | A batch of notification digests is delivered | `companyId` | `frequency` (daily/hourly), `notificationCount` |
| `auth.signup_completed` | better-auth database hook (`user.create.after`) | A new user account is created (sign-up via email or Google OAuth) | `userId` | `login_method` ("google", "email", or "unknown") |
| `auth.session_started` | better-auth database hook (`session.create.after`) | A new session is created (sign-in via email or Google OAuth) | `userId` (the logging-in user) | `login_method` ("google", "email", or "unknown") |

### distinctId Rule

All business events use `companyId` as the `distinctId` (never the default `"paperclip-server"`). This ensures per-company analytics are possible. The actor identity is included in the `properties` object when applicable.

### Error Events distinctId

Starting with VOY-1420, error events (`captureErrorEvent`) also use `companyId` as `distinctId` (resolved from `req.actor?.companyId`), falling back to `"paperclip-server"` when no actor is available. Previously all error events used `undefined` as the default. This enables per-company error tracking.

### Stack Trace Handling

**Since VOY-1456 P2-1 (b6c96c2f55):** The `sanitizeErrorForTelemetry()` function now operates on a **clone** of the error object. It creates a copy via `cloneError()` (preserving the error's prototype, message, stack, cause, and custom properties), redacts the clone's `message` and `stack`, and recursively redacts the clone's `cause` chain. The **original error object is never mutated** — any code that reads the original after the call sees the unredacted values. PostHog's `captureException` receives the redacted clone and auto-extracts `$exception_stack_trace` from it, with the stack trace pointing at the **original throw site** — not the sanitizer code.

**What gets redacted:** File paths, emails, tokens, connection strings, and other sensitive patterns in both the error message and stack trace are replaced with `***REDACTED***`. The error name and error code (low-risk categorical identifiers) are preserved as-is.

**Verification:** The test suite asserts `expect(sanitized.stack).toContain('posthog.test.ts')` — confirming the stack trace survives redaction and still points at the original throw site in the test file.

**Caller contract:** Because `sanitizeErrorForTelemetry()` returns a clone, any code that reads `error.message` or `error.stack` **after** calling this function sees the original, unredacted values. If you need the redacted version, capture it from the returned sanitized clone before it goes out of scope. (This is the inverse of the pattern in `error-handler.ts`, where the HTTP response message is snapshotted *before* calling `captureErrorEvent`.)

**What changed over the version history:**

| Version | Behavior | Limitation |
|---------|----------|------------|
| v1.4.1 and earlier | `new Error(redactedMessage)` — stack trace points at `posthog.ts` sanitizer | Stack-based triage useless |
| v1.4.2–v1.5.0 (VOY-1430, in-place mutation) | Original error mutated in place — stack preserved, original object modified | Side effect: any code reading the error after the call sees redacted values |
| **v1.6.0 (VOY-1456 P2-1, cloneError)** | **Clone is redacted, original untouched** — stack preserved, original object unchanged | None — best of both worlds |

**Triage guidance:** Stack traces can be relied on for triage, but note that file paths and tokens in stack frames are redacted (replaced with `***REDACTED***`). The error `name` and `code` are preserved unchanged as low-risk identifiers.

### Debugging Business Events

```bash
# Query PostHog for approval events (via PostHog API)
curl -s "https://us.posthog.com/api/projects/{project_id}/events/?event=approval.approved" \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_API_KEY"

# Query PostHog for notification digest events
curl -s "https://us.posthog.com/api/projects/{project_id}/events/?event=notification.digest.sent" \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_API_KEY"

# Check if a specific company's events are flowing
curl -s "https://us.posthog.com/api/projects/{project_id}/events/?event=approval.approved&distinct_id={companyId}" \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_API_KEY"
```

### Auth Hook Resilience

PostHog telemetry calls in better-auth database hooks (`auth.signup_completed` and `auth.session_started`) are fire-and-forget — the `captureMetric()` function is synchronous and is **never awaited** within the hook. The enclosing function is marked `async` only for better-auth type contract compliance. If PostHog is unreachable, slow, or returns errors, the auth sign-in/sign-up response is never blocked or delayed. Errors are silently caught in a `try/catch` block.

This design means:
- Auth flow speed is independent of PostHog availability
- PostHog errors never surface to users (no timeouts, no 500s during login/signup)
- Some auth events may be silently dropped if PostHog is down — the telemetry gap is invisible to users

### What to Watch For

- **Missing business events** — If `approval.approved` or `notification.digest.sent` events stop appearing, check that PostHog is configured (env vars) and `captureMetric()` is not being filtered by a feature gate.
- **Zero counts in dashboards** — Business events rely on `companyId` as distinctId. If a company's events are not grouped correctly, verify the `captureMetric` call passes the correct `companyId`.
- **PII in event properties** — Error events are auto-redacted by `sanitizeErrorForTelemetry()`. Business event properties are **not** blanket-redacted, but the `decisionNote` property on `approval.approved` and `approval.rejected` events is now scrubbed via `redactSensitiveText()` (VOY-1434 / d5b3510587). Event properties added in future instrumentation may still contain user PII — check for free-text fields before assuming they are safe. If a PII leak is found in a business event, escalate to the CTO.
- **Auth events not appearing** — If `auth.signup_completed` or `auth.session_started` events stop appearing, check that PostHog is configured and that better-auth database hooks are registered (`server/src/auth/better-auth.ts` — `databaseHooks.user.create.after` and `databaseHooks.session.create.after`). These events fire regardless of login method (email or Google OAuth).

---

## Triage Workflow

### Step 1: Initial Assessment (within 15 min of issue creation)

Read the issue body to determine:

| Question | What to check |
|---|---|
| Is this a known issue? | Search existing issues for similar error signatures |
| Is this a regression? | Check git log for recent changes to the affected file/component |
| Is PII leaked? | Verify the error message contains no emails, tokens, or user IDs |
| Can I reproduce it? | Check if the error occurred in a repeatable flow (trip creation, checkout, etc.) |

### Step 2: Severity Validation

| Severity | Criteria | SLA | Actions |
|---|---|---|---|
| **CRITICAL** | App-breaking for all users (Sage down, checkout broken, auth broken) | 1 hour | Immediately tag CTO (5a914da0) via issue comment with `@CTO`, set issue priority=critical |
| **HIGH** | Feature broken for subset of users (search fails, itinerary not loading) | 4 hours | Investigate root cause. If can fix, do. If not, assign to CTO or Founding Engineer |
| **MEDIUM** | Non-critical failure (analytics not tracking, minor UI glitch) | 24 hours | Triage during next heartbeat. If low priority, move to backlog |
| **LOW** | Cosmetic or edge case (rare error path, expected failure handled gracefully) | Best effort | Acknowledge and close, or keep in backlog for monitoring |

**Note on PII:** Error messages and stack traces arriving in PostHog are already scrubbed by the server-side `sanitizeErrorForTelemetry()` function — secrets, file paths, emails, and connection strings are redacted on a **clone** of the error before egress; the original error object keeps its unredacted message and stack intact. If you see `***REDACTED***` in an error message or stack trace line, that is working as designed. The original error is still available in server logs (`journalctl`). For investigating PII leaks, check the server logs, not PostHog.

### Step 3: Root Cause Investigation

Common investigation paths:

1. **Sage AI errors (error_ai_load, error_ai_timeout):**
   - Check OpenRouter dashboard for rate limits / quota usage
   - Check `health` endpoint for Sage AI provider connectivity
   - Review recent Sage prompt changes in git log

2. **API errors (error_api_error):**
   - Check server logs on vps-1: `journalctl -u travel_app -n 50 --no-pager`
   - Check if the error correlates with a recent deploy
   - Verify request/response in browser dev tools

3. **Third-party errors (error_third_party):**
   - Check Stripe dashboard for webhook failures
   - Check OpenRouter/Sentry for upstream outages
   - Verify API keys are valid and not expired

4. **Database errors (error_db_query):**
   - Check connection pool saturation
   - Check for slow queries in pg_stat_activity
   - Verify DB migration status

5. **Client-side errors (error_client_error):**
   - Check browser console logs
   - Verify feature flags are set correctly
   - Check if error correlates with specific browser/OS

### Step 4: Resolution

| Outcome | Action |
|---|---|
| Known issue, already tracked | Close the issue with a comment linking to the existing tracking issue |
| One-off / transient | Close with comment noting the error was transient and not reproducible |
| Real bug, can fix | Assign to appropriate engineer, add reproduction steps |
| Real bug, cannot fix | Assign to CTO with full investigation notes |
| False positive (PII leak, misclassification) | Fix the source (add PII sanitization, correct severity) and close |

---

## Escalation Path

| Situation | Escalate To | How |
|---|---|---|
| CRITICAL severity | CTO (5a914da0) | Tag in issue: `@CTO — CRITICAL error, app-breaking` |
| PII in error payload | CTO (5a914da0) | Tag in issue with the PII details (sanitized for the comment) |
| Recurring same error after fix | CTO (5a914da0) | Tag with recurrence count and previous fix reference |
| Monitoring script not creating issues | CTO (5a914da0) | Check PostHog API key, cron job, state file |
| System-wide outage | CEO (c2a215b2) + CTO | Tag both, set priority=critical |

---

## Monitoring Script Details

**Script:** `scripts/posthog-error-monitor.sh` (bash, 441 lines)
**Schedule:** Crontab `*/15 * * * *` (every 15 minutes)
**State file:** `/var/tmp/posthog_monitor_last_check` (ISO timestamp of last successful check)
**Cooldown:** 60 minutes per error signature (prevents alert fatigue)
**Max issues per run:** 20
**Pending retry dir:** `/var/tmp/posthog_pending/` (saved if Paperclip API is unreachable)
**Env vars required:** `POSTHOG_API_KEY` (or `POSTHOG_PERSONAL_API_KEY`), `POSTHOG_PROJECT_ID`, `POSTHOG_HOST` (default: https://us.posthog.com), `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`
**Defaults:** `SUPPORT_ENGINEER_ID=88b72065-5f95-4e2b-a6df-48d04363f0d9`, `PARENT_ISSUE_ID=VOY-999`

### Verification Commands

```bash
# Manual run (one-shot) — must set env vars first
./scripts/posthog-error-monitor.sh

# Run test suite
bash scripts/test-posthog-monitor.sh

# Check state file
cat /var/tmp/posthog_monitor_last_check

# Add crontab entry (VPS-1)
crontab -e
# */15 * * * * /app/scripts/posthog-error-monitor.sh
```

---

## Related

- [Environment ReadEnum Corrupt Driver](kb/environment-readenum-corrupt-driver.md)
- [Recovery Phantom-Park Protocol](kb/recovery-phantom-park-protocol.md)
- [Heartbeat Max Concurrent Runs](kb/heartbeat-max-concurrent-runs.md)
- [Child-Only Blocker Reclassification](kb/blocker-attention-child-only-classification.md)