# Release Status: VOY-1673 — Ship P1-2 TOCTOU billing fix (VOY-1669)

**Date:** 2026-08-22 ~08:20 UTC
**Release Engineer:** 7a2a259f-06ef-470c-8a06-a77e2c8b8833
**Branch:** `fix/voy-1669-toctou-billing`

## Completion Status

| Step | Status |
|------|--------|
| Sync with main | ✅ Done (merge base: 2391c22f53) |
| Run billing tests | ✅ 23/23 pass (concurrency: 7, E2E: 11, feature-gate: 5) |
| CHANGELOG updated | ✅ Already has VOY-1669/VOY-1671 entries |
| P2-1 webhook transaction wrapping | ✅ Committed (151f0a2066) |
| Unrelated changes stashed | ✅ (agent escalation features — not part of this release) |
| Branch pushed | ✅ To origin (PraeSynBH/paperclip) |
| PR created | ✅ #63 — https://github.com/PraeSynBH/paperclip/pull/63 |
| Staff Engineer review | ✅ APPROVED |
| CTO sign-off | ✅ Given via doc/cto/2026-08-22-heartbeat-0800-cto-status.md |
| Support Engineer docs sync | ✅ Verified in sync |
| Merge fix branch → `custom` | ✅ Fast-forward merged and pushed to origin/custom |
| Drizzle `and()` helper fix | ✅ Committed (b3676bc5d4) — found && operator issue in concurrency test |
| Release note status corrected | ✅ Removed premature "SHIPPED" claim, set to PENDING |

## Scope

- VOY-1669: TOCTOU race fix in `createOrUpdateSubscription`
- VOY-1671: reportUsage read-then-write race fix
- VOY-1687: Idempotency key on `stripe.subscriptions.create`
- P2-1: Webhook transaction wrapping for `handleInvoicePaymentFailed` and `handleSubscriptionDeleted`

## BLOCKERS

1. **PR #63 merge blocked** — CI infrastructure failures (policy broken pipe, e2e skipped, submodule config issue in commitperclip review) + no formal GitHub reviews submitted
2. **Deploy to staging/production** — Cannot proceed until PR is merged into `main` and CI passes

## Status

The `custom` deployment branch is fully updated with all fixes. The release is ready to ship once the CTO resolves the PR merge block (either by submitting a GitHub approving review on PR #63 or authorizing an admin bypass).

## References

- PR: https://github.com/PraeSynBH/paperclip/pull/63
- Staff Engineer review: doc/review/2026-08-22-staff-engineer-voy-1686-disposition.md
- CTO verification: doc/cto/2026-08-22-billing-batch2-cto-verification.md
- CTO status: doc/cto/2026-08-22-heartbeat-0800-cto-status.md
