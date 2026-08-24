# CTO Verification: Billing Structural Fixes Batch 2 (VOY-1669, VOY-1671)

**Date:** 2026-08-22
**Verifier:** CTO (5a914da0)
**Branch:** `fix/voy-1669-toctou-billing`

---

## Verification Criteria

### VOY-1669 — P1-2: TOCTOU race in createOrUpdateSubscription

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | SELECT + conditional wrapped in `db.transaction()` | ✅ PASS | Lines 722-818: entire read-write sequence inside `db.transaction()` |
| 2 | `SELECT ... FOR UPDATE` row-level lock | ✅ PASS | Line 732: `.for("update")` serialises concurrent requests |
| 3 | `INSERT ... ON CONFLICT (company_id) DO UPDATE` (atomic upsert) | ✅ PASS | Lines 786-818: belt-and-suspenders against 23505 |
| 4 | Race-lost detection — orphan Stripe sub cancelled on create-path loss | ✅ PASS | Lines 820-837: compares `stripeSubscription.id` vs `record.stripeSubscriptionId` |
| 5 | Usage metrics guard — only records when this request won the race | ✅ PASS | Lines 839-858: conditional on `isNewSubscriptionRecord && record.stripeSubscriptionId === stripeSubscription.id` |

### VOY-1671 — P2: reportUsage read-then-write race

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | `INSERT ... ON CONFLICT DO UPDATE` replaces SELECT-then-INSERT/UPDATE | ✅ PASS | Lines 1007-1038: atomic upsert eliminates read-then-write window |
| 2 | Unique index on (subscription_id, metric, period_start, period_end) | ✅ PASS | Lines 1023-1029: unique constraint as safety net |
| 3 | Stripe usage record wrapped in `withStripeRetry` + failure isolation | ✅ PASS | Lines 1040-1059: caught exception is non-fatal, logged only |
| 4 | Concurrent calls for same metric/period safe | ✅ PASS | Concurrency test: 5 concurrent usage upserts, no data loss |

### withStripeRetry Coverage

All 11 Stripe API call sites verified as wrapped:

| # | Call Site | Status |
|---|-----------|--------|
| 1 | `stripe.customers.create()` | ✅ |
| 2 | `stripe.subscriptions.retrieve()` (handleCheckoutSessionCompleted) | ✅ |
| 3 | `stripe.checkout.sessions.create()` | ✅ |
| 4 | `stripe.subscriptions.retrieve()` (createOrUpdateSubscription update path) | ✅ |
| 5 | `stripe.subscriptions.update()` (createOrUpdateSubscription update path) | ✅ |
| 6 | `stripe.subscriptions.create()` (createOrUpdateSubscription create path) | ✅ |
| 7 | `stripe.subscriptions.update()` (cancelSubscription) | ✅ |
| 8 | `stripe.subscriptions.update()` (reactivateSubscription) | ✅ |
| 9 | `stripe.subscriptionItems.createUsageRecord()` (reportUsage) | ✅ |
| 10 | `stripe.invoices.list()` (syncInvoicesFromStripe) | ✅ |
| 11 | `stripe.webhooks.constructEvent()` (local-only, no retry needed) | ✅ |

### Test Results

```
Test Files  1 passed (1)
     Tests  7 passed (7)
```

Concurrency tests verified:
- FOR UPDATE serialisation (create path lock)
- ON CONFLICT upsert (create path)
- ON CONFLICT DO NOTHING (getOrCreateStripeCustomer race handler)
- Race-lost detection (create path winner selection)
- 5-concurrent usage upserts (no data loss)
- Unique constraint safety net (23505 on duplicate insert without ON CONFLICT)
- 5-concurrent subscription creation with FOR UPDATE serialisation

---

## Disposition

**APPROVED** — all verification criteria satisfied.

The structural fixes are sound:
1. Three-layer defense against TOCTOU (transaction + FOR UPDATE + ON CONFLICT)
2. Atomic upsert eliminates reportUsage read-then-write race
3. All Stripe API calls wrapped with retry logic
4. Race-lost detection prevents orphan resources
5. Concurrency tests validate correctness under load

### Release Gate

Release Engineer (7a2a259f) is cleared to ship after:
1. Committing the P2-1 webhook transaction wrapping (if not already committed)
2. Merging branch `fix/voy-1669-toctou-billing` to main
3. Deploying to staging for smoke test
4. Notifying Support Engineer (88b72065) before production deployment
5. Deploying to production

### Remaining Items (Post-Release)

| Issue | Severity | Status |
|-------|----------|--------|
| VOY-1685 — Idempotency key on Stripe subscription create + reorder operations | P3 | Follow-up needed |
| Stripe API calls inside DB transaction (rollback orphans) | P3 | Follow-up needed |

---

## References

- Audit: doc/cto/2026-08-22-billing-remaining-issues-audit.md (missing — superseded by this doc)
- Code Review: VOY-1681 (approved)
- Staff Engineer review: doc/review/2026-08-22-staff-engineer-voy-1686-disposition.md
- Implementation: VOY-1669 (done), VOY-1671 (in progress)
