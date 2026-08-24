# Staff Engineer Review Disposition: VOY-1669 — FINAL

**Reviewer:** Staff Engineer (eee825c7)
**Initial Review:** 2026-08-22 ~05:05 UTC
**Final Review:** 2026-08-22 ~05:45 UTC
**Branch:** `fix/voy-1669-toctou-billing`
**Commits reviewed:**
  - `b840497fab` — initial optimistic approach (ON CONFLICT DO NOTHING, no transaction)
  - `1b901f8a8d` — fix: add transaction + FOR UPDATE to createOrUpdateSubscription
  - `e5a8217f8e` — test: add concurrent billing concurrency test (VOY-1669/1671)
  - `45a89a344a` — docs: add release note and concurrency test for VOY-1669

---

## Structural Audit Results

### Criteria Check (final state on HEAD)

| # | Criterion | HEAD (committed) | Status |
|---|---|---|---|
| 1 | `db.transaction()` wrapping SELECT + UPDATE/INSERT | ✅ `db.transaction()` at line 726 + `SELECT ... FOR UPDATE` at line 736 | PASS |
| 2 | `ON CONFLICT (company_id) DO UPDATE` on INSERT | ✅ `.onConflictDoUpdate({ target: companySubscriptionsTable.companyId })` at line 805 | PASS |
| 3 | No regressions in billing flow | ✅ All Stripe calls wrapped in `withStripeRetry`; reportUsage uses atomic upsert; syncInvoicesFromStripe wrapped; cancel/reactivate wrapped | PASS |
| 4 | Concurrent-duplicate INSERT test | ✅ `billing-concurrency.test.ts` (7 tests): FOR UPDATE serialisation, ON CONFLICT upsert, ON CONFLICT DO NOTHING, 5-concurrent usage upserts, unique constraint safety net | PASS |

### Required Before Shipping — ALL MET

1. ~~Commit the working tree diff~~ → ✅ Committed in `1b901f8a8d`
2. ~~Add concurrent-duplicate test~~ → ✅ Committed in `e5a8217f8e`

### Structural Assessment

The final committed implementation uses three defensive layers against the TOCTOU race:

1. **`SELECT ... FOR UPDATE`** inside `db.transaction()` — row-level lock serialises concurrent requests for the same company's subscription row. TX2 blocks until TX1 commits, then reads TX1's inserted row and takes the update path instead of the create path.

2. **`ON CONFLICT DO UPDATE`** — atomic upsert on `company_id`. Even if the FOR UPDATE lock were bypassed (e.g., a different code path), the second INSERT becomes an UPDATE instead of throwing 23505.

3. **StripeSubscriptionId comparison** — if the create path fired but the upsert reveals a different stripeSubscriptionId (another request won the race), the orphan Stripe subscription is cancelled with a warning log. Usage metrics are only inserted when the creating request actually won the race.

### Additional scope covered in this branch

- **VOY-1671**: `reportUsage` converted from SELECT-then-UPDATE/INSERT to `INSERT ... ON CONFLICT DO UPDATE` (atomic upsert). Unique index on `(subscription_id, metric, period_start, period_end)` provides belt-and-suspenders protection.
- **`createCheckoutSession`**: wrapped `stripe.checkout.sessions.create` in `withStripeRetry`.
- **`cancelSubscription`** / **`reactivateSubscription`**: wrapped `stripe.subscriptions.update` calls in `withStripeRetry`.
- **`syncInvoicesFromStripe`**: wrapped `stripe.invoices.list` in `withStripeRetry`.

### Systemic Finding (still open, reported to CTO)

Stripe API calls (subscriptions.create / subscriptions.update) execute inside the DB transaction block. If the DB transaction rolls back after a successful Stripe API call, a dangling Stripe resource is left behind. The race-lost detection (lines 828-839) mitigates the create-path case but does not protect against generic transaction rollback. Recommend a targeted follow-up to implement compensating-cancellation or reorder operations so Stripe API calls become the last operation before the DB write.

### Recommendation

**APPROVED** — all review conditions satisfied.

All required fixes have been committed and verified. The implementation is structurally sound with three layers of defense. The concurrency test suite covers both the subscription creation race and the reportUsage race.

**Next gate: CTO sign-off for shipping.**

Gate: CTO sign-off.