# Staff Engineer Structural Audit: VOY-1590 Stripe Billing E2E Verification

**Reviewer:** Staff Engineer  
**Date:** 2026-08-21  
**Issue:** VOY-1590  
**Parent:** VOY-1587 (COO: Execute Customer Acquisition + Onboarding & Conversion cycle)  
**Status:** ❌ BLOCKED — 9 structural issues found  

---

## Executive Summary

The billing **API skeleton** (service + routes + schema + migrations) was code-reviewed and approved by the CTO on Aug 20 (VOY-1552, v0.5.0 final review). The code is sound. But the **end-to-end billing flow described in VOY-1590 does not exist in this deployment**. The acceptance criteria cannot be verified in the current state because the operational infrastructure, UI surfaces, and several critical code paths are missing.

**What exists:** Server-side billing API (POST/PATCH/GET subscription, cancel, reactivate, usage, invoices, overview, webhook receiver) — 10 tests pass, 0 tests fail.

**What's missing:** Stripe keys, tier data, UI pages, checkout integration, feature gating, webhook idempotency, and several webhook event handlers.

---

## Structural Findings

### Blocker 1: No Stripe API keys configured
**Severity: P0** — Entire billing flow is non-functional.

- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are not set in the instance environment (`~/.paperclip/instances/default/.env` has only 3 vars: PAPERCLIP_AGENT_JWT_SECRET, PAPERCLIP_CONFIG, PAPERCLIP_INSTANCE_ID)
- `POST /api/billing/webhook` returns **500 Internal Server Error** on any request (including requests with missing/invalid signatures, which should return 400). Root cause: `handleWebhook()` calls `getStripeClient()` which throws before `stripe.webhooks.constructEvent()` is reached.
- **Defect:** Webhook endpoint returns 500 instead of the graceful "STRIPE_SECRET_KEY not set" error. Stripe will see 500s and retry, and the Stripe dashboard will show webhook delivery failures. This violates acceptance criterion "No 500 errors in billing-related API calls."

### Blocker 2: No subscription tiers seeded
**Severity: P0** — Pricing page has nothing to display; no tier to subscribe to.

- `subscription_tiers` table: **0 rows** (verified via live DB query on embedded postgres port 54329)
- `GET /api/companies/:companyId/billing/tiers` returns `[]`
- `POST /api/companies/:companyId/billing/subscription` with any tierId returns 404 "Subscription tier not found"
- No seed script, bootstrap, or fixture exists for subscription tiers anywhere in the codebase

### Blocker 3: No billing/pricing UI exists
**Severity: P0** — The flow described in the issue requires a user-facing pricing page and subscribe button.

- No billing/pricing page in the UI routing (`ui/src/` — 0 matches for "billing" or "pricing" in router, main, or App files)
- No billing route component exists (`ui/src/pages/` — no Billing.tsx, Pricing.tsx, or similar)
- No billing navigation item in the sidebar
- The "Billing page" referenced in docs (`/guides/board-operator/billing-setup.md`) does not exist as a UI page

### Blocker 4: Flow mismatch — described UX vs implemented API
**Severity: P0** — The issue describes a customer-facing checkout flow, but the implementation is a server-side direct API subscription creation.

| Issue flow | Actual implementation |
|---|---|
| "Land on pricing page" | No pricing page exists |
| "Click subscribe on a paid tier" | No subscribe button |
| "Complete Stripe checkout (test card 4242...)" | No Stripe Checkout Session integration (`stripe.checkout.sessions` is not called anywhere in the codebase) |
| "Post-subscription redirect lands on board" | No redirect flow |
| "Declined card / requires auth test cards" | Only works in Checkout/PaymentIntent flows — implementation uses `stripe.subscriptions.create()` directly, which has no card entry UI |

The implementation uses `stripe.subscriptions.create()` with the server secret key. A new customer has no payment method attached, so:
- `stripe.subscriptions.create()` with no `default_payment_method` produces an `incomplete` subscription (not `active`)
- No card collection UI exists — a new subscriber has no way to provide a card
- Test card numbers (4242, 4000...) are irrelevant — they only work in Checkout/PaymentIntent flows

### Blocker 5: No feature gating / paywall logic
**Severity: P0** — "Subscribed features functional" and "features degrade correctly" cannot be verified.

- Zero code paths check subscription status or tier before allowing features
- No searchable pattern for "subscription required", "paywall", "feature gate", or "tier check" in feature code paths
- The only subscription status check is in `reportUsage()` requiring status "active" — this is about reporting usage, not gating features
- "Cancellation degrades features at period end" has no mechanism: `cancelAtPeriodEnd` sets a boolean, but no code reads subscription status to block features
- No "downgrade to free tier" logic exists

### Defect 6: Webhook idempotency gap — duplicate invoice rows on retry
**Severity: P1** — Acceptance criterion "Webhook delivery failures — verify idempotency" is not structurally handled.

- `subscription_invoices.stripe_invoice_id` has a non-unique index (`INDEX`, not `UNIQUE INDEX`)
- `handleInvoicePaid()` does select-then-insert/update without a transaction boundary
- Stripe delivers webhooks at-least-once. Duplicate/retried `invoice.paid` events can race (both select sees no existing row → both insert) → duplicate invoice rows with the same `stripeInvoiceId`
- There is no event-id dedup table (no `stripe_webhook_events` or similar idempotency key tracking)
- No `customer.subscription.created` webhook handler (only handles `subscription.updated`, `subscription.deleted`)

### Defect 7: Webhook returns 500 instead of 400 for bad signatures (when keys missing)
**Severity: P2** — Violates acceptance criterion "No 500 errors."

- `getStripeClient()` is called inside `handleWebhook()` before `stripe.webhooks.constructEvent()` is reached
- When STRIPE_SECRET_KEY is missing, every webhook request returns 500 instead of 400
- Stripe's webhook delivery system will see 500s and retry, creating a retry storm

### Finding 8: No subscription.created webhook handler
**Severity: P2** — Recovery path gap.

- Webhook switch handles: `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.trial_will_end`
- Missing: `customer.subscription.created`
- If the direct API subscription creation succeeds (Stripe side) but the server crashes before DB insert, there's no reconciliation path

### Finding 9: No real-time subscription status propagation
**Severity: P2** — Acceptance criterion "Subscription status is reflected in UI immediately (not just after webhook)" cannot be met.

- No SSE/push mechanism for subscription status changes
- No UI surface to reflect status changes
- Subscription status is only updated via Stripe webhooks (async, seconds to minutes delay)

---

## What Works (Verified)

- ✅ **Server boots cleanly** — billing routes mounted, webhook route wired before auth
- ✅ **Auth boundary** — 7 billing-routes tests pass: agent API keys rejected with 403 on all mutation endpoints (create, update, cancel, reactivate, report usage, sync invoices); board users can read tiers
- ✅ **Graceful degradation** — 3 tests pass: missing STRIPE_SECRET_KEY gives descriptive error; key present gives different error (Stripe validation)
- ✅ **DB migration applied** — 0137_billing_tables.sql: all 5 tables exist with correct schema
- ✅ **Webhook endpoint wired** — responds at `POST /api/billing/webhook` (before auth middleware)
- ✅ **Revenue-neutral** — no billing code runs without Stripe keys; API simply returns errors

---

## Disposition

**BLOCKED.** The E2E billing flow described in VOY-1590 cannot be verified because the required product surfaces do not exist. The codebase has a server-side billing API skeleton that was code-reviewed and approved, but the customer-facing billing flow (pricing page, checkout, payment collection, feature gating) has not been implemented.

### Required to unblock

| # | Requirement | Owner | Priority |
|---|---|---|---|
| 1 | Provision Stripe test keys (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET) | Operator/DevOps | P0 |
| 2 | Seed subscription tiers with Stripe test price IDs | Product/Dev | P0 |
| 3 | Build billing/pricing UI page | Frontend Engineer | P0 |
| 4 | Integrate Stripe Checkout Session for card collection | Full-stack Engineer | P0 |
| 5 | Implement feature gating / paywall logic | Full-stack Engineer | P0 |
| 6 | Fix webhook idempotency (add unique constraint on stripe_invoice_id + event dedup) | Backend Engineer | P1 |
| 7 | Add customer.subscription.created webhook handler | Backend Engineer | P2 |
| 8 | Fix webhook 500→400 when keys missing | Backend Engineer | P2 |
| 9 | Add real-time subscription status propagation | Full-stack Engineer | P2 |

### Recommendation

Create child issues for each blocker/finding, then re-scope this issue to a **structural verification of the billing API skeleton** (which passes) with a new E2E verification issue after the customer-facing billing flow is built.