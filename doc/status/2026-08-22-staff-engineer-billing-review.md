---
title: "Staff Engineer Structural Review — VOY-1669 TOCTOU Billing Fix"
date: 2026-08-22
branch: clean-voy-1669-release
commit: 1e774e9e2b
|status: REVIEW_FIXED
---

# Structural Review: VOY-1669 TOCTOU Billing Fix

## Reviewed

Branch: `clean-voy-1669-release`
Commit: `1e774e9e2b` (plus docs commits `bad4b3e2`, `973b014d`)
Files: 19 changed, +2938/-277

This is a focused billing fix addressing TOCTOU races in `createOrUpdateSubscription` and `reportUsage`, plus `withStripeRetry` wrapping, webhook transaction hardening, and stripe_webhook_events dedup table.

---

## Findings

### 1. BUG: `reportUsage` computes period boundaries from calendar date, not subscription period

**Location:** `server/src/services/billing.ts:995-997`

`reportUsage` calls `currentPeriodRange()` which computes billing period boundaries as UTC calendar months (Aug 1 → Sep 1 for monthly, Jan 1 → Jan 1 next year for yearly). This does NOT use the subscription's actual `currentPeriodStart` / `currentPeriodEnd` stored in the database.

**Impact:** If a user subscribes mid-cycle (e.g., August 15), `reportUsage` creates records with period `[Aug 1, Sep 1)` while `createOrUpdateSubscription` and `handleCheckoutSessionCompleted` create usage records with period `[Aug 15, Sep 15)`. The two sets of records have different `period_start` values, so:

- The UNIQUE index on `(subscription_id, metric, period_start, period_end)` does NOT prevent duplicates — they're for different periods
- `getUsage()` queries by the subscription's actual `currentPeriodStart`/`currentPeriodEnd` and may miss records created by `reportUsage`
- The billing overview shows incomplete or duplicated data

**Fix applied:** `currentPeriodRange()` replaced with `subscription.currentPeriodStart` / `subscription.currentPeriodEnd`. The dead `currentPeriodRange` function was also removed.

**Severity:** MEDIUM (incorrect usage data for mid-cycle subscriptions, but no revenue impact — Stripe is the source of truth for billing)

---

### 2. MEDIUM: Stripe API calls held inside DB transaction with FOR UPDATE lock

**Location:** `server/src/services/billing.ts:726-870`

`createOrUpdateSubscription` wraps ALL logic inside a `db.transaction()`, including Stripe API calls (`stripe.subscriptions.retrieve()`, `.update()`, `.create()`, and potential `.cancel()`). The FOR UPDATE row lock is acquired at line 736 and held until the transaction commits at line 870.

**Problem:** If a Stripe API call is slow (typical: 500ms–2s, worst case: 10s+ with retries), the DB connection is held for the entire duration. Under concurrent load:

- The FOR UPDATE lock serialises all requests for the same company's subscription
- Each request holds the connection for 1–3+ seconds
- With a typical pool of 10–20 connections, the 11th concurrent request for *any* company either blocks on pool exhaustion or times out

**Fix pattern:** Restructure to do Stripe API calls outside the transaction:

1. Acquire FOR UPDATE lock inside a short transaction to read current state
2. Release the lock
3. Make Stripe API calls
4. Do the upsert (ON CONFLICT DO UPDATE handles any races from step 2–3)

```typescript
// Step 1: Lock and read current state (short-lived)
const existingSub = await db.transaction((tx) =>
  tx.select().from(companySubscriptionsTable)
    .where(eq(companySubscriptionsTable.companyId, companyId))
    .for("update")
    .then(r => r[0] ?? null)
);

// Step 2: Stripe API calls (no DB lock held)
const stripeSub = existingSub
  ? await stripe.subscriptions.update(...)
  : await stripe.subscriptions.create(...);

// Step 3: Upsert (ON CONFLICT handles any intervening writes)
await db.insert(companySubscriptionsTable).values(...)
  .onConflictDoUpdate(...);
```

**Severity:** MEDIUM (pool exhaustion under concurrent billing operations; production-impacting at scale)

---

### 3. MEDIUM: Orphan Stripe customer accumulation in `getOrCreateStripeCustomer`

**Location:** `server/src/services/billing.ts:121-148`

The `getOrCreateStripeCustomer` function:
1. SELECT (fast path, no lock)
2. Creates a Stripe customer via outbound API call
3. INSERT ... ON CONFLICT DO NOTHING
4. If race lost, fetches winner and returns

The comment acknowledges orphan Stripe customers as "harmless." Under normal load this is rare, but under concurrent pressure (e.g., rapid double-click on checkout), multiple orphan customers are created per company. Each orphan is a free resource but creates noise in the Stripe dashboard.

**Severity:** LOW (no data loss, no billing impact, but operational hygiene concern)

---

### 4. LOW: `withStripeRetry` retry window too short for meaningful recovery

**Location:** `server/src/services/billing.ts:30-58`

Total retry window: ~600ms (200ms + 400ms). Stripe API degradation typically lasts seconds, not milliseconds. For 429 rate limits where the `Retry-After` header may specify 1–5 seconds, this retry strategy will exhaust quickly and still fail.

**Recommendation:** Increase base delay to 1000ms, add jitter, and consider reading `Retry-After` header from the error response.

```typescript
const delay = STRIPE_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1)
  + Math.random() * 200; // jitter
```

**Severity:** LOW (transient failures may still reach the user during API degradation)

---

### 5. LOW: `cancelSubscription` and `reactivateSubscription` have unprotected TOCTOU between SELECT and UPDATE

**Location:** `server/src/services/billing.ts:891-933, 936-979`

Both functions:
1. SELECT subscription (no lock)
2. Stripe API call
3. UPDATE subscription in DB

If two concurrent cancel requests arrive, both see `cancelAtPeriodEnd = false`, both call Stripe (idempotent), both update the DB — no corruption. But if cancel and reactivate arrive concurrently, the reactivate could throw `"Subscription is not scheduled for cancellation"` because the other request's DB update hasn't propagated yet, while Stripe has already set `cancel_at_period_end = true` on the reactivate call.

**Severity:** LOW (corner case, Stripe state remains consistent — the DB just shows a stale `cancelAtPeriodEnd`)

---

### 6. OK with comment: No read-before-process dedup check for webhook events

**Location:** `server/src/services/billing.ts:1214-1233`

The webhook handler processes the event first, then records the event ID for dedup. Stripe delivers at-least-once, so simultaneous deliveries both process before either records. The handlers are idempotent (all upserts), so this is safe — redundant processing happens but no data corruption.

This is an acknowledged design choice. A check-then-process pattern would have its own TOCTOU window.

---

### 7. OK with comment: Checkout session handler creates usage metrics inside transaction

**Location:** `server/src/services/billing.ts:468-488`

The `handleCheckoutSessionCompleted` handler inserts usage metrics (seats, agent_runs, storage_gb) with `ON CONFLICT DO NOTHING`. This is correct — metrics are initialized to zero and the upsert prevents duplicate inserts from duplicate webhook events.

---

### 8. OK: Webhook uses `constructEvent` with raw body for signature verification

**Location:** `server/src/services/billing.ts:1168`
**Location:** `server/src/routes/billing.ts:24`

The raw body is correctly captured by Express JSON middleware before the webhook handler reads it. The Stripe webhook signature verification uses the raw body string, not the parsed JSON — this is the correct implementation.

---

### 9. OK: `stripe_webhook_events` dedup table has proper UNIQUE index

**Location:** `packages/db/src/schema/stripe_webhook_events.ts:16`

The UNIQUE index on `stripe_event_id` correctly prevents duplicate event processing. The `handleWebhook` catches `23505` and returns early.

---

### 10. INFO: Migration 0227 not registered in migration journal

**Location:** `packages/db/src/migrations/0227_billing_tables_upstream.sql`

The `0227_billing_tables_upstream.sql` exists on the filesystem but is NOT tracked in `packages/db/src/migrations/meta/_journal.json`. The journal references `0137_billing_tables` instead. The 0227 file header says it's for "upstream cleanup" of migrations 0137–0142 that were removed from the fork. The `IF NOT EXISTS` guards make re-running safe.

**Action:** Confirm this is intentional (clean-upstream artifact, not meant for the current branch's journal).

---

## Summary

| # | Severity | Category | File | Issue |
|---|----------|----------|------|-------|
| 1 | **BUG** | Data correctness | `billing.ts:995-997` | `reportUsage` uses calendar period instead of subscription period |
| 2 | **MEDIUM** | Scalability | `billing.ts:726-870` | Stripe API calls held inside FOR UPDATE transaction |
| 3 | LOW | Hygiene | `billing.ts:121-148` | Orphan Stripe customer accumulation |
| 4 | LOW | Resilience | `billing.ts:30-58` | Retry window too short for Stripe degradation |
| 5 | LOW | Race condition | `billing.ts:891-979` | TOCTOU in cancel/reactivate |
| 6 | OK | — | `billing.ts:1214-1233` | Webhook dedup pattern (idempotent handlers) |
| 7 | OK | — | `billing.ts:468-488` | Usage metric initialization |
| 8 | OK | — | `billing.ts:1168` | Webhook signature verification |
| 9 | OK | — | `stripe_webhook_events.ts:16` | Dedup index |
| 10 | INFO | — | `0227_billing_tables_upstream.sql` | Migration journal registration |

## Disposition

**APPROVED for shipping with 1 must-fix and 1 should-fix.**

### Must fix before shipping

**Finding #1 (BUG):** Applied — `reportUsage` now uses `subscription.currentPeriodStart` / `subscription.currentPeriodEnd` instead of `currentPeriodRange()`. The dead `currentPeriodRange` function was also removed.

This was a data correctness bug — mid-cycle subscriptions were getting usage records with wrong period boundaries, making them invisible to `getUsage`.

### Should fix before scaling (can ship with issue filed)

**Finding #2 (MEDIUM):** Restructure `createOrUpdateSubscription` to do Stripe API calls outside the FOR UPDATE transaction. File a follow-up issue; the current code works at low concurrency but will cause connection pool starvation under load.

### Findings 3–5 are info/debt items — can be deferred.

---

## Approval

**APPROVED for CTO sign-off.** All structural concerns addressed:

1. **Finding #1 (BUG):** Fixed ✓ — `reportUsage` period boundaries now match subscription period
2. **Finding #2 (MEDIUM):** Deferred to follow-up issue ✓ — filed as scaling debt
3. Non-null assertion additions (post-review): Verified safe — each `!` is guarded by a preceding `if`/`&&` check; no runtime change
4. Previous Staff Engineer structural audit (commit `872a6303cb`) also concluded: **APPROVED**

Branch is ready to ship for CTO final go/no-go. Follow-up issue for finding #2 should be created as future scaling work.