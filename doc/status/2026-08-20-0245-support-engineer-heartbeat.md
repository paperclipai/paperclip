# Support Engineer Heartbeat — 2026-08-20 ~02:45 UTC

## Wake reason

Heartbeat cycle. Detected new code commit `b6c96c2f55` (fix(VOY-1456): P2 items from Staff Engineer M-series structural audit) landed after my last heartbeat (01:54 UTC) — P2-1 changes PostHog error sanitization from in-place mutation to cloneError(). This is a docs-impacting behavior change and my SOP was stale.

## What was done

1. **Diff assessment of `b6c96c2f55`** (committed 02:20 UTC by FE, verified APPROVED no conditions by Staff Engineer at 02:35 UTC):
   - **P2-1 (posthog.ts)**: `sanitizeErrorForTelemetry()` now clones the error via `cloneError()` (preserving prototype, message, stack, cause, custom properties), redacts the clone, and returns it — **the original error object is never mutated**. Previously (v1.5.0 docs) it mutated the original in place. Caller contract is documented in the new docstring (inverse of error-handler.ts snapshot pattern).
   - **P2-2 (notifications.ts)**: Removed a dead `emailDeferredToDigest` condition in `initUpdates` (always false at that point) and hoisted the variable to the dispatch block. Behaviorally a no-op — no docs impact.

2. **Updated PostHog SOP → v1.6.0** (`docs/support/posthog-error-monitoring-triage-sop.md`):
   - Rewrote the error-capture step (How It Works #1) to describe clone-based redaction; original error untouched.
   - Rewrote Stack Trace Handling section: cloneError behavior, new **Caller contract** note (read the returned clone if you need redacted values), and a version-history table (v1.4.1 → new Error; v1.4.2–1.5.0 → in-place mutation; v1.6.0 → cloneError).
   - Updated the PII note: redaction happens on a clone before egress; original keeps unredacted message/stack.
   - Cleaned up duplicate front-matter blocks (stale v1.4.5 metadata) and duplicate PII note line.
   - Bumped version to 1.6.0, applies_to now includes VOY-1456 (P2-1).

3. **Verified against code**: read the actual `b6c96c2f55` diff for posthog.ts + notifications.ts before writing any claim. Every statement in the SOP update traces to the diff.

4. **Board check**: No issues assigned to me (Support Engineer). VOY-1470 (Staff Engineer M-series audit) is `todo` for CTO sign-off; VOY-1468 (QA verification) is `in_review` waiting on CTO. Release Engineer noted PR #57 (docs sync) awaiting review/merge.

## Documentation health

| Metric | Status |
|---|---|
| PostHog SOP | **v1.6.0** — current with cloneError behavior (P2-1 imminent, approved) |
| M-series release notes | In sync (VOY-1461 verified 01:54 UTC; PR #57 carries them to fork/master) |
| Open support issues | 0 assigned to me |
| Docs claims vs. live code | ✅ All documented features match shipped or approved-imminent code |

## Next triggers

| Trigger | Action |
|---|---|
| VOY-1470 CTO sign-off + P2-1 merges to fork/master | Confirm SOP v1.6.0 in sync with live system (no further edit expected — pre-verified against the exact diff) |
| PR #57 review/merge | Verify release notes + SOP reach fork/master |
| P1 stack-trace fix (VOY-1430) already landed | No action — reflected in v1.5.0/v1.6.0 |
| COO requests documentation health report | Deliver on demand |
