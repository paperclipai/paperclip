# Staff Engineer Structural Audit: Checkout Session Integration (VOY-1590)

**Reviewer:** Staff Engineer
**Date:** 2026-08-21
**Branch:** custom (working tree vs origin/docs-deploy-voy-1413)
**Context:** VOY-1590 Follow-up — Stripe Checkout Session + webhook race fix
**Tests:** 19/19 billing tests pass (4 new checkout-session-webhook tests, 9 route tests, 3 graceful-degradation, 3 dist)

---

## Executive Summary

The implementer addressed Finding B (update/insert race in `handleSubscriptionUpdated`) and Blocker 4 (no Checkout Session integration) from the v2 review. The Checkout Session endpoint `POST /api/companies/:companyId/billing/create-checkout-session` is correctly wired, auth-bound, and documented.

**However, the fix introduces 2 new P0/P1 structural bugs and leaves 1 critical gap from the v2 review unaddressed.** The TOCTOU race is not fixed — it is now a three-way race between `handleSubscriptionUpdated`, `handleCheckoutSessionCompleted`, and the existing `createOrUpdateSubscription` insert. A new `company_id` unique constraint violation path is introduced for re-subscribe/upgrade flows.

**Disposition: ❌ BLOCKED — must fix before shipping**

---

## Findings

### P0 — `checkout.session.completed` breaks for companies with an existing subscription

**File:** `server/src/services/billing.ts:322-358`
**Schema:** `packages/db/src/schema/company_subscriptions.ts:28`

The `company_subscriptions` table has a table-level constraint:
```
CONSTRAINT "company_subscriptions_company_unique_idx" UNIQUE("company_id")
```
This means **one subscription row per company — enforced by the database.**

`handleCheckoutSessionCompleted` (line 322) does a raw INSERT into `companySubscriptionsTable` with the companyId from session metadata. It checks for an existing row by `stripeSubscriptionId` only (line 286-295), **not by `companyId`**.

**Failure scenario:** A company that already has a subscription row in the DB (e.g., they canceled, or they're upgrading) creates a new Checkout Session → Stripe creates a new subscription → `checkout.session.completed` fires → `handleCheckoutSessionCompleted` inserts a new row with the same `companyId` → **unique constraint violation → 500**. Stripe retries the webhook indefinitely → the subscription is active in Stripe but never appears in our DB. The customer paid, our system has no record.

`handleSubscriptionUpdated`'s fallback insert (line 228-240) has the **same vulnerability**: it inserts with `companyId` without checking if a row for that company already exists.

**Fix required:** Either:
(a) Pre-check in `createCheckoutSession` — if the company already has a subscription, route to the existing subscription path (update Stripe subscription in place) or reject with 422, or
(b) In `handleCheckoutSessionCompleted`, check for existing subscription by `companyId` and update the existing row's `stripeSubscriptionId` rather than inserting a new one, or
(c) Change the schema to allow >1 subscription per company (remove the unique constraint) and have `getSubscriptionInternal` pick the latest active one — but this is a larger schema change.

**Recommendation: (a) + (b)** — pre-check and fail early in the API, and make the webhook handler robust regardless.

---

### P0 — TOCTOU race between webhook handlers strips usage rows

**File:** `server/src/services/billing.ts:170-249, 264-364`

Stripe fires `customer.subscription.created` and `checkout.session.completed` within seconds of each other after a successful checkout. Both handlers do select-then-insert **without a transaction and without `ON CONFLICT`**:

| Handler | Checks by | Insert creates usage rows? |
|---|---|---|
| `handleSubscriptionUpdated` (fallback, line 228) | `stripeSubscriptionId` | ❌ No |
| `handleCheckoutSessionCompleted` (line 322) | `stripeSubscriptionId` | ✅ Yes |

**Race outcome when `customer.subscription.created` fires first** (documented Stripe ordering — subscription.created fires before checkout.session.completed in most cases):

1. `customer.subscription.created` → `handleSubscriptionUpdated` → select by `stripeSubId` → not found → **INSERT subscription row, NO usage rows**
2. `checkout.session.completed` → `handleCheckoutSessionCompleted` → select by `stripeSubId` → **found** → logs "already exists" → **skips**
3. **Final state: company has a subscription row with zero usage rows.** `getSubscriptionInternal` returns `usage: []`.
4. The seeded usage rows are **permanently lost** — the checkout handler never creates them.

**Race outcome when both run concurrently** (both select before either inserts):

1. Handler A selects → not found → inserts → wins
2. Handler B selects → not found → inserts → **unique constraint violation on `stripe_subscription_id`** → 500 → Stripe retries → on retry, row exists → skipped
3. **Final state: self-heals on Stripe retry** but produces a 500 in webhook logs; the winner's usage rows are correct (if checkout handler won) or missing (if subscription handler won).

**Fix required:** Replace all select-then-insert patterns with a single atomic upsert:
```sql
INSERT INTO company_subscriptions (...) VALUES (...)
ON CONFLICT (stripe_subscription_id) DO UPDATE SET ...
```
And ensure usage rows are created by **both** paths (or by a shared function called after the upsert). Use a DB transaction for the subscription + usage rows.

---

### P1 — No Stripe event-level idempotency (v2 Finding C, still open)

**File:** `server/src/services/billing.ts:829-890`

The webhook handler processes every event without deduplication by `event.id`. Stripe delivers webhooks at-least-once. The recommended `stripe_webhook_events` table with UNIQUE(`stripe_event_id`) does not exist.

The `subscription_invoices` table has **no unique constraint on `stripe_invoice_id`** — only a non-unique B-tree index (migration line 115). `handleInvoicePaid` does select-then-insert without unique protection. Duplicate `invoice.paid` deliveries can create duplicate invoice rows.

With the Checkout Session flowing real payments, invoice events are no longer theoretical — they will arrive. This must be fixed before production traffic.

**Fix required:** Add a `stripe_webhook_events` table for event dedup, add a unique index on `stripe_invoice_id`, or both.

---

### P1 — Usage-row period bounds diverge between seeding and querying

| Code path | Period bounds used |
|---|---|
| `handleCheckoutSessionCompleted` (line 346-358) | `created.currentPeriodStart/End` — Stripe subscription period |
| `createOrUpdateSubscription` (line 543-579) | `currentPeriodRange(billingPeriod)` — **calendar month** |
| `handleSubscriptionUpdated` fallback | ❌ None created |
| `reportUsage` (line 669-680) | `currentPeriodRange(billingPeriod)` — calendar month |
| `getUsage` (line 751-769) | `subscription.currentPeriodStart/End` — Stripe period |

The checkout path seeds usage with Stripe-subscription period bounds (e.g., Aug 15 → Sep 15). `reportUsage` queries by calendar month bounds (Aug 1 → Sep 1). These **do not match** for subscriptions created mid-month. After checkout, the first `reportUsage` call will find no matching row (period mismatch) and **insert a second usage row** with calendar-month bounds, leaving the checkout-seeded row orphaned.

Functions reading usage (`getSubscriptionInternal`, `getUsage`) query by `subscription.currentPeriodStart/End` — they find the checkout-seeded row. But `reportUsage` writes to calendar-month bounds. This is a pre-existing inconsistency that the checkout path now makes reachable for real users.

**Fix required:** Align all paths to use the same period bounds. Either use Stripe's subscription period everywhere (preferred) or use calendar-month everywhere. The query path (`getSubscriptionInternal`, `getUsage`) already uses Stripe period, so the seeding should match.

---

### P1 — `handleCheckoutSessionCompleted` doesn't assert customer→company match

**File:** `server/src/services/billing.ts:305-316`

The handler looks up a local Stripe customer record by `stripeCustomerId` (Stripe's `cus_*` ID):
```ts
const cust = await db.select().from(stripeCustomersTable)
  .where(eq(stripeCustomersTable.stripeCustomerId, stripeCustomerId))
  .then((r) => r[0] ?? null);
```

Then inserts a subscription row with `companyId` from session **metadata**:
```ts
await db.insert(companySubscriptionsTable).values({
  companyId,  // from metadata
  stripeCustomerId: cust.id,  // local UUID
  ...
})
```

It never asserts `cust.companyId === companyId`. If the metadata's `paperclipCompanyId` doesn't match the customer record's `companyId`, the subscription row binds a customer record from one company to a subscription owned by another company.

The metadata is set server-side in `createCheckoutSession` (line 439-443) and the webhook is signed, so this is defense-in-depth rather than an active exploit. But it's a one-line invariant that protects against future bugs:
```ts
if (cust.companyId !== companyId) throw new Error("Customer/company mismatch");
```

---

### P2 — `stripeSub.customer` unsafe cast

**File:** `server/src/services/billing.ts:303`
```ts
const stripeCustomerId = sessionCustomerId ?? stripeSub.customer as string;
```

`stripe.subscriptions.retrieve()` returns `customer` as `string | Stripe.Customer | Stripe.DeletedCustomer`. The `as string` cast is only safe if the subscription is retrieved without expanding the `customer` field. By default, Stripe does NOT expand, so it's a string. But the handler should handle both forms, matching the pattern used for `session.customer` (lines 300-302):
```ts
const sessionCustomerId = session.customer
  ? (typeof session.customer === "string" ? session.customer : session.customer.id)
  : null;
```

---

### P2 — Formatting regression in `handleSubscriptionUpdated`

**File:** `server/src/services/billing.ts:170-249`

The entire function body is indented 12 spaces (8 extra) from the `const` keyword. This is a clear formatting regression that will be flagged by any formatter (prettier, dprint, etc.). The diff shows the whole block was re-indented during the edit.

---

### P3 — Missing success-path test for `create-checkout-session` route

**File:** `server/src/__tests__/billing-routes.test.ts`

The route tests only cover:
- 403 for agent keys (2 tests: subscription create, checkout session)
- 400 for invalid tierId (schema validation)

No test exercises the 200 path with a mocked Stripe client. The service function `createCheckoutSession` is not unit tested (price selection fallback, metadata, defaults). The webhook test file shows the Stripe-mock pattern; the route success path should be tested similarly.

### P3 — No race-condition or re-subscribe test coverage

**File:** `server/src/__tests__/billing-checkout-session-webhook.test.ts`

The webhook tests are well-structured (4 tests) but do not cover:
- The race scenario where both `handleCheckoutSessionCompleted` and `handleSubscriptionUpdated` fire for the same subscription
- A company re-subscribing via checkout after having an existing subscription row
- The usage-rows-missing scenario (subscription.created handler wins the race)

---

## v2 Review Status Reconciliation

| # | Finding | v2 Status | Current Status | Notes |
|---|---|---|---|---|
| 1 | No Stripe keys in .env | ✅ FIXED | ✅ FIXED | Unchanged |
| 2 | No subscription tiers seeded | ✅ FIXED | ✅ FIXED | Unchanged |
| 3 | No billing/pricing UI | ❌ Open | ❌ Open | Still missing — out of scope for this diff |
| 4 | No Checkout Session | ❌ P0 | ✅ **ADDRESSED** | New endpoint + handler + docs added |
| 5 | No feature gating | ❌ Open | ❌ Open | Still missing — out of scope |
| 6 | Webhook idempotency gap | ❌ P1 | ❌ **Open** | Not addressed |
| 7 | Webhook →500 on bad sig | ✅ FIXED | ✅ FIXED | Unchanged |
| 8 | No `subscription.created` handler | ✅ FIXED | ✅ **CHANGED** | Handler now exists but has new issues |
| 9 | No real-time status propagation | ❌ Open | ❌ Open | Still missing |
| B | Update/insert race in handleSubscriptionUpdated | ❌ P1 | ❌ **NOT FIXED** | Race still exists, now between TWO handlers + new usage-rows gap |
| C | No Stripe event-id dedup | ❌ P1 | ❌ **Open** | Not addressed |

---

## Required to Unblock

| # | Fix | Criticality | Owner | Notes |
|---|---|---|---|---|
| 1 | **Handle `company_id` unique constraint in checkout path** | **P0** | Implementer | Pre-check in `createCheckoutSession` + upsert in `handleCheckoutSessionCompleted` |
| 2 | **Replace select-then-insert with atomic upsert** | **P0** | Implementer | Use `INSERT ... ON CONFLICT (stripe_subscription_id) DO UPDATE` in both handlers |
| 3 | **Create usage rows in subscription fallback path** | **P0** | Implementer | `handleSubscriptionUpdated` fallback must create usage rows too |
| 4 | **Add event-level dedup (`stripe_webhook_events` table)** | **P1** | Implementer | v2 Finding C — required before production traffic |
| 5 | **Align usage-row period bounds** | **P1** | Implementer | Use Stripe subscription period everywhere |
| 6 | **Add customer→company match assertion** | **P1** | Implementer | `cust.companyId !== companyId` guard in `handleCheckoutSessionCompleted` |
| 7 | **Fix `stripeSub.customer as string` cast** | **P2** | Implementer | Handle both string and expanded object |
| 8 | **Fix indentation** | **P2** | Implementer | 8-space over-indentation in `handleSubscriptionUpdated` |
| 9 | **Add success-path route test** | **P3** | Implementer | Mock Stripe, test 200 response for checkout session |
| 10 | **Add race/re-subscribe tests** | **P3** | Implementer | Concurrent handler scenario + existing company subscription |

---

## Upstream: Approved for Merge

- Route wiring and auth guards ✅
- Validator schema (`createCheckoutSessionSchema`) ✅
- API documentation in `docs/api/billing.md` ✅
- Webhook route remains before auth middleware ✅
- All 19 billing tests pass ✅
- `validate()` middleware integration ✅
- `requireBoardUser` pattern consistent with other billing routes ✅

---

## Disposition

**❌ BLOCKED — must fix P0 items (1-3) before shipping.**

The Checkout Session integration is directionally correct and well-scoped to the existing architecture. The code is generally clean with consistent style (indentation bug aside). But the structural issues described above are exactly the kind that pass CI and punch you in production:

1. **The re-subscribe/upgrade path is broken** — the first checkout works, but the second one 500s permanently.
2. **Usage rows are silently dropped** in the common race between webhook events.
3. **Event dedup is absent** — real money events will arrive at-least-once.

The P0 items should be fixed in this branch before merge. The P1 items should be fixed before the checkout endpoint is surfaced in the UI (they are safe if the database is manageable and Stripe retries are monitored, but risky at scale).

**Routing:** Findings sent to implementer (Founding Engineer). On fix, re-verify and route to CTO for final go/no-go.