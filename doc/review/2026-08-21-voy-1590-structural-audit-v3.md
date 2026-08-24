# Staff Engineer Structural Audit: VOY-1590 Stripe Billing E2E (v3)

**Reviewer:** Staff Engineer
**Date:** 2026-08-21 (current heartbeat, ~15:40 UTC)
**Issue:** VOY-1590 — Stripe billing flow E2E verification
**Status:** ❌ BLOCKED

## Executive Summary

Re-verified the billing infrastructure after the CTO disposition at 15:27 UTC. The server-side infrastructure is solid and CTO-approved. The E2E verification remains structurally blocked by the same gaps identified in v2.

**What's new this heartbeat:**
- Confirmed feature gating logic (checkFeatureAccess/requireFeature) exists and has 10 tests — but ZERO routes call it. Dead code until wired.
- Reviewed and confirmed the race condition in handleSubscriptionUpdated is NOT actually fixed (see Finding B below).
- Resolved stale merge conflict markers in package.json and server/vitest.config.ts that were blocking vitest.
- Confirmed 13 billing tests pass across 2 test files.

## Verified Working

| Component | Status |
|-----------|--------|
| Billing API skeleton — routes, service, webhook handler all wired | ✅ |
| 3 subscription tiers seeded with real Stripe price IDs | ✅ |
| Webhook endpoint mounted before auth middleware, returns 400 on bad sig | ✅ |
| Checkout Session integration (createCheckoutSession + handleCheckoutSessionCompleted) | ✅ |
| Cancellation/reactivation endpoints (POST: cancel, reactivate) | ✅ |
| Feature gating logic (checkFeatureAccess/requireFeature) — defined, tested | ✅ |
| 13 billing tests pass (billing-routes: 9, billing-checkout-session-webhook: 4) | ✅ |
| billing-feature-gate.test.ts exists (10 tests) — skipped in this env (no embedded-postgres) | ✅ |

## Structural Issues

### P0: Feature gating NOT wired into any feature route
`requireFeature` and `checkFeatureAccess` are implemented, exported from billingService, and tested (10 tests in billing-feature-gate.test.ts). But **zero route handlers or service methods call them**. Agents, routines, projects, plugins — all feature endpoints return 200 for unsubscribed users.

```
grep -rn "requireFeature\|checkFeatureAccess\|paywall" src/routes/ src/services/
  → only matches in billing.ts itself (definition + return statement)
  → zero callers outside the billing module
```

VOY-1609 is structurally incomplete — the gating mechanism exists but is not wired into any feature code path.

### P0: No pricing/billing UI exists
Zero pages in `ui/src/pages/` for pricing, billing, or subscription management. The entire customer-facing checkout flow is server-only via direct API calls. VOY-1611 is still todo.

### P0: Test-mode keys blocked on human
Stripe keys configured in .env are live production keys. E2E testing with test cards (4242...) requires test-mode keys from Stripe dashboard. VOY-1613 blocked on CEO.

### P1: Race condition in handleSubscriptionUpdated (Finding B — NOT fixed)
Both `customer.subscription.created` AND `customer.subscription.updated` route to the same handler (`handleSubscriptionUpdated`, billing.ts:171-250). The select-then-insert race window:

1. `customer.subscription.created` fires → SELECT sees no record → INSERT
2. `customer.subscription.updated` fires → SELECT sees no record (first INSERT not committed yet) → INSERT
3. Second INSERT hits UNIQUE(stripe_subscription_id) constraint → throws error
4. Error propagates uncaught → webhook endpoint returns 500 to Stripe → `updated` event data is lost

The CTO disposition at 15:27 UTC marked this as "fixed" (`handleSubscriptionUpdated` now does select-then-insert-or-update, preventing the created/updated event race). This is incorrect — the code does select-then-INSERT, not INSERT ... ON CONFLICT DO UPDATE. I verified the source at billing.ts:196-247. The race window between SELECT and INSERT is still open.

**Fix needed:** Wrap in a transaction with `INSERT ... ON CONFLICT (stripe_subscription_id) DO UPDATE`.

### P1: Webhook idempotency gap (VOY-1616)
- No `stripe_webhook_events` table for event-id dedup
- `subscription_invoices.stripe_invoice_id` is a non-unique INDEX (migration 0137, line 115), not a UNIQUE constraint
- `handleInvoicePaid` does select-then-insert without transaction
- Stripe delivers webhooks at-least-once → duplicate invoice rows on retried events

### P2: No real-time subscription status propagation (VOY-1617)
No SSE/websocket events for subscription changes. UI cannot reflect status without polling.

## Critical Blocking Assessment

E2E flow cannot be verified because:

1. **No pricing UI** → cannot click "Subscribe" to initiate the flow
2. **No gating wired into features** → cannot verify paywall enforcement even if subscribed
3. **No test keys** → Stripe Checkout requires test-mode keys
4. **Idempotency gap** → production webhook processing is unsafe (duplicate rows, race conditions)

The server-side billing infrastructure (VOY-1594) is solid and approved. The customer-facing layers and production safety are missing.

## Disposition

**VOY-1590 → blocked.** Four blockers in priority order:

| # | Blocker | Issue | Owner | Priority |
|---|---------|-------|-------|----------|
| 1 | No pricing/billing UI | VOY-1611 | Founding Engineer | P0 |
| 2 | Feature gating not wired into routes | VOY-1609 | Founding Engineer | P0 |
| 3 | Test-mode keys (human step) | VOY-1613 | CEO | P0 |
| 4 | Webhook idempotency + race condition fix | VOY-1616 | Founding Engineer | P1 |

Re-scoped: return for verification when all four are resolved.

## Cleanup Done This Heartbeat

- Resolved stale merge-conflict markers in `package.json` (line 46: `<<<<<<< HEAD ... ======= ... >>>>>>> main`) — was blocking vitest, caused "Expected string in JSON but found <<" error
- Resolved stale merge-conflict markers in `server/vitest.config.ts` (lines 6-56: same pattern) — was blocking vitest
- Verfied both files are now clean (`git diff` shows no changes)