---
title: PostHog Business Events + P2 Fixes
version: voy-1420
date: 2026-08-19
commits: 1dfe01c6be / e63b2a1f67 / d5b3510587 / 8416165284 / c306d8ef37 / a46b6e62dd
---

# PostHog Business Events + P2 Fixes

**Branch:** `voy-1420-posthog-p2-fixes`
**Release date:** 2026-08-19
**Status:** Shipped to `voy-1420-posthog-p2-fixes` branch. All P2 fixes committed, 34/34 tests pass, stack traces preserved, PII redacted. Pending merge to fork/master.

## What Changed

### Business Event Telemetry

The Voyonder platform now sends key product events to PostHog for monitoring and analytics:

| Event | Trigger | Data |
|---|---|---|
| `approval.approved` | An approval (hire, strategy decision, plan gate) is approved | approval ID, type, decision maker, timestamp, redacted decision note |
| `approval.rejected` | An approval is rejected | approval ID, type, decision maker, timestamp, redacted decision note |
| `notification.digest.sent` | A batch of notification digests is delivered | frequency (daily/hourly), notification count |

All business events use the company ID as the PostHog distinct ID, enabling per-company analytics. The decision note on approval events is automatically scrubbed of sensitive data (email addresses, tokens, file paths) before leaving the server.

### Error Telemetry Improvements

- Error events (`captureErrorEvent`) now use the requesting company's ID as the PostHog distinct ID instead of a generic server identifier — enabling per-company error tracking
- Stack traces on captured exceptions now point at the **original throw site** (a route handler, service, or library) instead of clustering on the sanitizer in `posthog.ts`. File paths and tokens in stack frames are still redacted, but the filename and line number context is preserved for triage
- The `decisionNote` property on approval events is now auto-redacted via `redactSensitiveText()` before egress to PostHog, closing a PII leak path

### Ops Resilience

- Web push subscription expiry warnings (410/404) are now deduplicated per endpoint — each endpoint logs at most one warning, preventing log spam at scale
- Email sending and web push delivery failures due to missing Node.js networking modules are now caught gracefully with a logged warning instead of an unhandled import error

## Support Impact

### For Support Staff

| Change | What to know |
|---|---|
| Business events live | Events are visible in PostHog dashboards. Use the PostHog project API to query `approval.approved`, `approval.rejected`, and `notification.digest.sent` events. |
| Stack traces reliable | Stack traces on PostHog-created error issues can now be trusted for triage. The throw site is preserved (file paths redacted). |
| PII protection | `decisionNote` on approval events is auto-redacted. Error messages and stacks are also redacted. Any new business event properties added in the future should be audited for PII. |
| VAPID warnings | If push subscription expiry warnings appear in support logs, they are now deduplicated — one log per stale endpoint instead of per send attempt. This is expected behavior for stale push subscriptions. |

### Configuration

No new environment variables or configuration changes. PostHog integration continues to use existing `POSTHOG_API_KEY`, `POSTHOG_PROJECT_ID`, and `POSTHOG_HOST` settings.

## Related Documentation

- [PostHog Monitoring Triage SOP](../posthog-error-monitoring-triage-sop.md) — v1.4.5, reflects all P2 fixes + Google OAuth auth events
- PostHog Triage SOP: Error troubleshooting workflows, escalation paths, and monitoring script details