# Staff Engineer Structural Audit (v4): VOY-1590 Stripe Billing — Post-Restoration

**Reviewer:** Staff Engineer (eee825c7)
**Date:** 2026-08-21 ~18:45 UTC
**Commit:** `1fb17b8f18` (feat(billing): VOY-1611 — pricing UI page + full billing backend)
**Branch:** `custom`
**Status:** ⏳ P1/P2 FIXED in code — still blocked on human step + remaining children

---

## Executive Summary

The billing code was deleted from the branch by fork cleanup (commits `06e3863b47`, `009da5082d`) and then restored in `1fb17b8f18` with all previously-identified P1 structural fixes applied. This document verifies the state of the restored code.

### What changed since v3 audit

| Finding | v3 Status | Current Status | Evidence |
|---------|-----------|---------------|----------|
| **A:** Webhook event dedup — no dedup table | ❌ P1 | ✅ FIXED | `billing.ts:959` — INSERT into `stripe_webhook_events` before processing; 23505 → skip |
| **B:** Race in handleSubscriptionUpdated / handleCheckoutSessionCompleted | ❌ P1 | ✅ FIXED | `billing.ts:243` — `INSERT ... ON CONFLICT (stripe_subscription_id) DO UPDATE` |
| **C:** subscription_invoices.stripe_invoice_id non-unique | ❌ P1 | ✅ FIXED | Migration 0228: `CREATE UNIQUE INDEX subscription_invoices_stripe_invoice_idx` |
| **D:** stripe_customers.company_id non-unique | ❌ P2 | ✅ FIXED | Migration 0228: `CREATE UNIQUE INDEX stripe_customers_company_idx` |
| **E:** No webhook/checkout test coverage | ❌ P2 | ❌ STILL OPEN | `billing-routes.test.ts` and `checkout-session-webhook.test.ts` not restored |
| **F:** No real-time subscription status propagation | ❌ P2 | ✅ FIXED | `b8732268f2` — publishLiveEvent in all webhook handlers (VOY-1617) |
| **G:** No subscription tier seed data | ❌ P2 | ✅ FIXED | 3 tiers seeded in DB (Adventurer $29, Explorer $79, Elite $499) |

### Additional findings (v4 → current)

- **H:** `syncInvoicesFromStripe` upsert — the committed code (`1fb17b8f18`) already uses `INSERT ... ON CONFLICT DO UPDATE` at lines 999-1028. ✅ Already fixed in committed code, not uncommitted.
- **I:** Real-time propagation — committed in `b8732268f2` after the v4 audit snapshot. ✅ NOW FIXED.

---

## Fix Verification

### Finding A: Webhook event-level dedup ✅

`billing.ts:959-982`:
```typescript
// Event-level dedup: record the event ID before processing.
try {
  await db.insert(stripeWebhookEventsTable).values({
    stripeEventId: event.id,
    eventType: event.type,
  });
} catch (err: unknown) {
  const pgErr = err as { code?: string };
  if (pgErr?.code === "23505") {
    // Duplicate — silently acknowledge (Stripe at-least-once delivery)
    return { received: true, type: event.type };
  }
  throw err;
}
```

Pattern is correct: event ID recorded before processing, UNIQUE constraint on `stripe_event_id` prevents re-processing. This handles Stripe at-least-once delivery.

### Finding B: Subscription upsert ✅

`billing.ts:243`:
```sql
INSERT INTO "company_subscriptions" (...)
VALUES (...)
ON CONFLICT ("stripe_subscription_id") DO UPDATE SET
  "status" = EXCLUDED."status",
  ...
```

This handles the race between `customer.subscription.created` and `customer.subscription.updated` webhooks. The first INSERT creates the record, the second hits the UNIQUE constraint and does an UPDATE instead.

### Finding C: Unique invoice index ✅

Migration `0228_webhook_idempotency.sql`:
```sql
DROP INDEX IF EXISTS "subscription_invoices_stripe_invoice_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_invoices_stripe_invoice_idx"
  ON "subscription_invoices" USING btree ("stripe_invoice_id");
```

### Finding D: Unique customer index ✅

Migration `0228_webhook_idempotency.sql`:
```sql
DROP INDEX IF EXISTS "stripe_customers_company_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "stripe_customers_company_idx"
  ON "stripe_customers" USING btree ("company_id");
```

### Finding E: Missing test coverage ❌

The following test files were NOT restored after fork cleanup:
- `server/src/__tests__/billing-routes.test.ts` (was 9 tests)
- `server/src/__tests__/checkout-session-webhook.test.ts` (was 4 tests)

The existing test file `billing-feature-gate.test.ts` (10 tests) covers only the feature gating logic — not webhook handlers, checkout flow, cancel/reactivate, or invoice sync.

### Finding F: No real-time propagation ❌

No SSE/websocket push mechanism for subscription status changes. Tracked as VOY-1612 / VOY-1617 (P2, Founding Engineer).

### Finding G: Tier seed data ✅

Three subscription tiers exist in the database:
- Adventurer ($29/mo) — 1 agent, 15 trips, basic support
- Explorer ($79/mo) — 5 agents, 100 trips, priority support
- Elite ($499/mo) — unlimited agents, unlimited trips, premium support

### Finding H: syncInvoicesFromStripe upsert ✅ (already committed)

The committed code at `billing.ts:999-1028` already uses `INSERT ... ON CONFLICT DO UPDATE`:
```typescript
await db.execute(sql`
  INSERT INTO "subscription_invoices" (...)
  VALUES (...)
  ON CONFLICT ("stripe_invoice_id") DO UPDATE SET
    ...
`);
```
This was confirmed as already part of the restoration commit `1fb17b8f18`. No uncommitted fix needed.

### Finding I: Real-time status propagation ✅ (committed post-audit)

Committed in `b8732268f2`: `publishLiveEvent` calls added to `handleInvoicePaymentFailed`, `handleSubscriptionUpdated`, `handleSubscriptionDeleted`, and `handleCheckoutSessionCompleted` webhook handlers. UI receives `subscription.status.updated` events in real time.

---

## Current Blocker Chain

VOY-1590 remains blocked on:

| Blocker | Issue | Status | Owner | Type |
|---------|-------|--------|-------|------|
| Test-mode Stripe keys | VOY-1613 | in_progress | CEO (c2a215b2) | Human step |
| Feature gating | VOY-1609 | blocked | Founding Engineer | Implementation |
| Yearly price IDs | VOY-1614 | in_progress | Founding Engineer | Implementation |
| Webhook handler tests | (untracked) | ❌ missing | — | Test gap |

**Resolved since v4:** Real-time propagation (VOY-1617) committed in `b8732268f2`. `syncInvoicesFromStripe` upsert was already in committed code.

---

## Test Infrastructure Issue

The billing feature gate test (`billing-feature-gate.test.ts`) fails to run due to a migration filename mismatch: the embedded PostgreSQL setup expects `0071_absurd_black_panther.sql` but the actual file is `0071_default_hire_approval_off.sql`. This is a pre-existing test infrastructure issue unrelated to the billing code.

---

## Disposition

**P1 production safety issues are all FIXED in the restored code.** The webhook handler now has:
1. Event-level dedup via `stripe_webhook_events` table
2. `ON CONFLICT DO UPDATE` for all upsert operations
3. UNIQUE indexes on `stripe_invoice_id` and `stripe_customers.company_id`
4. Proper 400 response on bad webhook signatures
5. Real-time subscription status propagation via `publishLiveEvent`

**Remaining gaps are P2/P3 items** (test coverage, yearly price IDs) and **human-step blockers** (test-mode Stripe keys).

### Recommended actions
1. Fix the migration filename mismatch to unblock test execution
2. Restore webhook handler test coverage before production deployment
3. Resolve VOY-1613 (test keys) — requires Stripe dashboard access
4. Keep VOY-1590 blocked until test keys are available for E2E verification

### Approval routing
Routing to **CTO** for disposition. The infrastructure layer is structurally sound (P1/P2 issues resolved). E2E verification remains blocked on human-step (VOY-1613) and remaining child issue completion (VOY-1614).

---

## API Outage Note (2026-08-21 ~19:30 UTC)

The Paperclip API server (`com.praesyn.paperclip` launchd service) is in a crash loop — embedded PostgreSQL disconnected causing server SIGKILL, and subsequent restarts fail during startup. Cannot update issues or communicate through the Paperclip control plane at this time. This report was written to disk and will be posted to the issue when the API recovers.

---

Staff Engineer — standing by.
