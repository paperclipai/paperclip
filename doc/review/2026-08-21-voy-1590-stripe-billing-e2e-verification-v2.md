# Staff Engineer Structural Re-Audit: VOY-1590 Stripe Billing E2E (v3)

**Reviewer:** Staff Engineer
**Date:** 2026-08-21 (fourth pass — final structural audit)
**Issue:** VOY-1590
**Parent:** VOY-1587
**Status:** ❌ BLOCKED — implementation complete, P1 idempotency gaps remain

---

## Executive Summary

The full billing implementation — server-side service, API routes, webhook handlers, feature gating, pricing UI, API client — is on disk and functionally complete. All 10 feature gate tests pass. The implementation is gated behind `PAPERCLIP_BILLING_ENABLED=true` (not set by default), preventing accidental activation.

**What was verified this heartbeat:**
- ✅ **10/10 billing feature gate tests** (checkFeatureAccess / requireFeature) — PASS
- ✅ **Feature gating wired into routes** — `access.ts` gates API key creation behind `FEATURE_KEYS.API_ACCESS`; `agents.ts` gates agent creation behind `FEATURE_KEYS.ADVANCED_AGENTS`
- ✅ **Webhook error path** — properly returns 400 (not 500) when `STRIPE_WEBHOOK_SECRET` is missing (fixed since v1 audit)
- ✅ **Feature gate** — `PAPERCLIP_BILLING_ENABLED=true` prevents billing routes from being mounted; safe to ship with gate disabled
- ✅ **Pricing UI** — tier display, Checkout Session redirect, subscription status, cancel/reactivate
- ✅ **Checkout Session integration** — `createCheckoutSession` route + `handleCheckoutSessionCompleted` webhook handler
- ✅ **All 5 billing tables** with proper schema and indexes in migration 0227
- ✅ **Stripe LIVE keys exist** in instance env (but feature gate prevents activation)

**What's still blocking:**
- ❌ **P1: Webhook idempotency** — no event dedup table; `subscription_invoices.stripe_invoice_id` is non-unique index; select-then-insert without `ON CONFLICT DO UPDATE`
- ❌ **P1: Race in handleSubscriptionUpdated / handleCheckoutSessionCompleted** — concurrent Stripe events can hit UNIQUE constraint and produce 500
- ❌ **P2: Missing UNIQUE constraint on `stripe_customers.company_id`** — current index is non-unique; concurrent `getOrCreateStripeCustomer` calls can create duplicate Stripe customers
- ❌ **P2: Zero test coverage** on webhook handlers, checkout flow, cancel/reactivate, invoice sync — the billing-routes test files were removed during fork cleanup and not restored
- ❌ **P2: No real-time subscription status propagation** (SSE/websocket)
- ❌ **No subscription tier seed data** in committed code — tiers must be seeded manually or via a bootstrap script

---

## Structural Audit Findings

### [P1] Finding A: Webhook idempotency gap — no event dedup table

**Status: Still Open**

The webhook handler at `billing.ts:930` processes every event without tracking `stripe_event_id`. Stripe delivers webhooks at-least-once. Without a `stripe_webhook_events` table with `UNIQUE(stripe_event_id)`, duplicate events can produce:
- Duplicate invoice rows (from `handleInvoicePaid`)
- Race-condition inserts on subscription records (from `handleSubscriptionUpdated`)

### [P1] Finding B: Race in handleSubscriptionUpdated / handleCheckoutSessionCompleted

**Status: Still Open**

Both handlers use select-then-insert without a transaction or `ON CONFLICT DO UPDATE`. If `customer.subscription.created` and `checkout.session.completed` arrive simultaneously, both selects miss and the second insert hits the `UNIQUE(stripe_subscription_id)` constraint, producing an unhandled 500 error.

### [P1] Finding C: subscription_invoices.stripe_invoice_id is non-unique index

**Status: Still Open**

Migration 0227 creates a regular index, not a unique index, on `stripe_invoice_id`. The `handleInvoicePaid` handler does select-then-insert. Combined with Stripe at-least-once delivery, duplicate invoices can be created.

### [P2] Finding D: Missing UNIQUE constraint on stripe_customers.company_id

**Status: Still Open**

Migration 0227 creates a non-unique index on `stripe_customers.company_id`. The `getOrCreateStripeCustomer()` function (billing.ts:57-97) does select-then-insert. Without a unique constraint, two concurrent calls could both miss the select and create two Stripe customers for the same company.

### [P2] Finding E: No test coverage on webhook/checkout paths

**Status: Still Open**

Current tests cover only `checkFeatureAccess` (7 tests) and `requireFeature` (3 tests). The `billing-routes.test.ts` and `checkout-session-webhook.test.ts` files were removed during fork cleanup and not restored. Missing tests for:
- Webhook signature verification (success + failure paths)
- `handleInvoicePaid` (create + update invoice)
- `handleSubscriptionUpdated` (create + update subscription)
- `handleCheckoutSessionCompleted` (happy path + race scenario)
- `createCheckoutSession` (Stripe API interaction)
- `cancelSubscription` / `reactivateSubscription`
- `reportUsage` / `syncInvoicesFromStripe`
- `getBillingOverview`

### [P2] Finding F: No real-time subscription status propagation

**Status: Still Open**

No SSE/websocket push mechanism for subscription status changes. UI only reflects state on page load.

### [P3] Finding G: Stripe API version hardcoded

**Status: Still Open**

`billing.ts:26` hardcodes `apiVersion: "2025-02-24.acacia"`. Should be configurable via env var.

### [P3] Finding H: N+1 query in getSubscriptionInternal

**Status: Still Open**

`getSubscriptionInternal` (billing.ts:367-398) fetches subscription, then tier, then usage in three separate queries. Acceptable for single-company reads but problematic at scale.

---

## What's Fixed Since v1 Audit

| Issue | v1 Finding | Current Status |
|-------|-----------|----------------|
| Webhook returns 500 instead of 400 when keys missing | ❌ Blocker 7 | ✅ Fixed — `handleWebhook` checks `STRIPE_WEBHOOK_SECRET` first, returns 400 |
| No `customer.subscription.created` webhook handler | ❌ Finding 8 | ✅ Fixed — handler at billing.ts:974 |
| No billing/pricing UI | ❌ Blocker 3 | ✅ Fixed — Pricing.tsx on disk |
| No Checkout Session integration | ❌ Blocker 4 | ✅ Fixed — createCheckoutSession + handleCheckoutSessionCompleted |
| No feature gating | ❌ Blocker 5 | ✅ Fixed — checkFeatureAccess + requireFeature + middleware + wired into routes |
| Webhook not mounted before auth middleware | ❌ Defect 7 | ✅ Fixed — wired before auth in app.ts |

---

## Test Results

| Test Suite | Tests | Status |
|---|---|---|
| `billing-feature-gate.test.ts` (checkFeatureAccess/requireFeature) | 10 | ✅ PASS |
| `heartbeat-ledger-billing-code.test.ts` | 4 | ✅ PASS (not Stripe billing — heartbeat billing code propagation) |

**Note:** `billing-routes.test.ts` (9 tests) and `checkout-session-webhook.test.ts` (4 tests) were removed during fork cleanup and have not been restored.

---

## What's Verified Working

| Component | Status |
|---|---|
| Feature gating (checkFeatureAccess / requireFeature) | ✅ 10 tests pass |
| Feature gating wired into access.ts (API_ACCESS) | ✅ |
| Feature gating wired into agents.ts (ADVANCED_AGENTS) | ✅ |
| Webhook returns 400 on missing/bad signature | ✅ |
| All 5 billing tables exist with correct schema | ✅ |
| `customer.subscription.created` handler exists | ✅ billing.ts:974 |
| Checkout Session creation endpoint | ✅ createCheckoutSession |
| Pricing UI (tier display, checkout redirect, cancel/reactivate) | ✅ |
| Sidebar Billing nav entry | ✅ |
| `success` and `warning` badge variants | ✅ |
| Feature gate (PAPERCLIP_BILLING_ENABLED) prevents accidental activation | ✅ |

---

## Issues That Must Be Fixed Before Production Ship

| # | Issue | Severity | Owner |
|---|---|---|---|
| 1 | Stripe event-id dedup table + idempotent handlers | P1 | Founding Engineer |
| 2 | `subscription_invoices.stripe_invoice_id` → unique index | P1 | Founding Engineer |
| 3 | Transaction-wrap `handleSubscriptionUpdated` + `handleCheckoutSessionCompleted` | P1 | Founding Engineer |
| 4 | Add UNIQUE constraint on `stripe_customers.company_id` | P2 | Founding Engineer |
| 5 | Add test coverage for webhook handlers and checkout flow | P2 | Founding Engineer |
| 6 | Real-time subscription status propagation (SSE/websocket) | P2 | Founding Engineer |
| 7 | Seed subscription tier data (bootstrap script or migration) | P2 | Founding Engineer |

---

## Disposition

**BLOCKED for production.** The implementation is functionally complete and all existing tests pass. The remaining gaps are production safety issues:

1. **Webhook idempotency** (P1) — must be fixed before production traffic
2. **Race conditions** in webhook handlers (P1) — must be fixed before production traffic
3. **Test coverage** (P2) — webhook handlers and checkout flow have zero test coverage
4. **Tier seed data** (P2) — no committed seed script for subscription tiers

### What can be approved:
- ✅ Server-side billing service (all 15+ operations)
- ✅ API routes (webhook + 10 authenticated endpoints)
- ✅ Database schema (5 tables with proper indexes and constraints)
- ✅ Feature gating with paywall error propagation
- ✅ Feature gating wired into real routes (access.ts, agents.ts)
- ✅ Pricing UI with Stripe Checkout integration
- ✅ All existing tests pass
- ✅ Feature gate (PAPERCLIP_BILLING_ENABLED) prevents accidental activation

### What needs fixes before ship:
- ❌ Webhook idempotency (P1)
- ❌ Race conditions in webhook handlers (P1)
- ❌ UNIQUE constraint on `stripe_customers.company_id` (P2)
- ❌ Test coverage for webhook/checkout handlers (P2)
- ❌ Subscription tier seed data (P2)

### Recommendation:
1. Fix P1 idempotency and race conditions before enabling `PAPERCLIP_BILLING_ENABLED` in production
2. Add the `company_id` unique constraint and invoice index fix
3. Add webhook handler test coverage before deploying to production
4. Create a seed script for subscription tiers
5. Real-time status propagation (P2) and API version config (P3) can ship later