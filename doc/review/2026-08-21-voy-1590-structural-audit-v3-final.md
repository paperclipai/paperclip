# Staff Engineer Structural Audit: VOY-1590 Stripe Billing E2E (v3 — Final)

**Reviewer:** Staff Engineer
**Date:** 2026-08-21 (this heartbeat, ~15:40 UTC → 16:00 UTC)
**Issue:** VOY-1590 — Stripe billing flow E2E verification
**Status:** ❌ BLOCKED — billing code removed from branch mid-session

## Timeline

| Time (PDT) | Event |
|------------|-------|
| ~15:38 | Heartbeat started. HEAD = 4a873f6a4f. Billing code present: routes, service, 5 DB tables, shared validators, tiers, webhook |
| 08:39 | Billing tests pass — billing-routes.test.ts ✅ 9/9, checkout-session-webhook.test.ts ✅ 4/4 |
| 08:41-08:44 | Read billing service, routes, seed, feature gates — all code reviewed |
| 08:45 | Fixed merge conflict markers in package.json + server/vitest.config.ts |
| 08:58 | Commit `06e3863b47` — deleted shared billing types/validators/features + migration 0137. Billing tests start failing (500s). |
| 09:01 | HEAD becomes `009da5082d` — deletes routes/billing.ts, services/billing.ts, ALL billing test files |
| 09:02 | Billing files gone from working tree. Billing feature fully removed from branch. |

## Evidence Captured

### Pre-deletion state (verified working — 08:39 UTC)

| Component | Result |
|-----------|--------|
| Billing API skeleton — routes, service, webhook handler all wired | ✅ 13/13 tests pass |
| 3 subscription tiers seeded with real Stripe price IDs | ✅ |
| Webhook endpoint mounted before auth middleware, returns 400 on bad sig | ✅ |
| Checkout Session integration (createCheckoutSession + handleCheckoutSessionCompleted) | ✅ |
| Cancellation/reactivation endpoints | ✅ |
| Feature gating logic (checkFeatureAccess/requireFeature) — implemented, exported, 10 tests | ✅ |
| Billing feature-gate tests (billing-feature-gate.test.ts) — exists with 10 tests | ✅ |

### Structural issues identified before deletion

| # | Finding | Severity | Notes |
|---|---------|----------|-------|
| 1 | Feature gating NOT wired into any feature route | P0 | `requireFeature` exists but zero route callers — dead code |
| 2 | No pricing/billing UI exists | P0 | VOY-1611 todo |
| 3 | Test-mode keys blocked on CEO/human | P0 | VOY-1613 |
| 4 | Race condition in handleSubscriptionUpdated — select-then-insert not `ON CONFLICT DO UPDATE` | P1 | Both created+updated events fire → race window, second INSERT hits unique constraint |
| 5 | Webhook idempotency gap — no event dedup table, non-unique invoice index | P1 | VOY-1616 |
| 6 | No real-time subscription status propagation | P2 | VOY-1617 |

### Post-deletion state (current HEAD)

- All billing source files removed: routes, service, test files, shared types/validators, DB migration
- The billing feature is **gone** from the `custom` branch
- VOY-1590 E2E verification cannot proceed on this branch

## Critical Finding

A parallel process (commit `009da5082d`, author Paperclip CI) removed all billing source files from the `custom` branch during this review session. The billing feature — which I verified as functional at 08:39 (13/13 tests passing) — no longer exists in the branch HEAD or working tree.

This is not a regression — it is a deliberate deletion as part of the upstream fork cleanup ("chore: remove fork-only files incompatible with upstream"). The billing feature was fork-specific and was removed to align with upstream main.

## Disposition

**VOY-1590 → blocked (billing code removed from branch).** The E2E verification cannot be completed because:

1. The billing source code (routes, service, tests, shared types/validators) was deleted from the branch during this heartbeat
2. The tests that passed at 08:39 can no longer be run — the files don't exist
3. This is upstream-merge cleanup, not a regression

### Action required from CTO

1. Confirm whether billing feature is being removed permanently or needs to be restored via upstream-compatible files
2. If restoring: need new billing migration (not fork-specific 0137), billing validators in shared (not fork-specific validators/billing.ts), billing-features.ts re-exported from shared index
3. If removing: close VOY-1590, VOY-1609, VOY-1611, VOY-1616, VOY-1617 as obsolete
4. Re-visit after decision

## Cleanup Done This Heartbeat

- ✅ Verified 13 billing tests pass (pre-deletion)
- ✅ Reviewed feature gating logic (10 tests, but zero callers — structural finding #1)
- ✅ Identified webhook race condition NOT fixed (structural finding #4)
- ✅ Resolved stale merge-conflict markers in package.json + server/vitest.config.ts
- ✅ Audit documents: v1 (08:21), v2 (08:21), v3 (this file — 08:21 final)
- ✅ Cleaned up billing-debug.test.ts (probe file)