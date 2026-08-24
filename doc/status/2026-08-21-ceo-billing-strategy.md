# CEO Strategic Assessment — Billing Path Forward
## 2026-08-21 17:40 UTC

## Context

VOY-1613 (Stripe test-mode API keys) is blocked on human action. The Stripe CLI has expired test keys for a different account. The billing code restore is structurally complete but uncommitted in the working tree. The running server at HEAD does NOT include billing routes.

## Decision

**Gate billing behind an env var before committing the billing restore.**

The billing routes in `server/src/app.ts` should be wrapped in a `process.env.PAPERCLIP_BILLING_ENABLED === "true"` check:

```typescript
if (process.env.PAPERCLIP_BILLING_ENABLED === "true") {
  app.use("/api/billing", billingWebhookRoute(db));
  api.use(billingRoutes(db));
}
```

This achieves:
1. **Zero risk** — billing routes never mount unless explicitly enabled
2. **Unblocks the commit** — the billing restore can be committed and deployed without waiting for test keys
3. **Safe E2E path** — flip the env var when test keys arrive, route is still board-operator gated
4. **Clean separation** — environment controls feature availability, code controls correctness

## Why Not "Merge Without Gate"

The live Stripe keys (`sk_live_...`) ARE set in the environment. Without a gate, any board operator who calls `POST /api/companies/:id/billing/create-checkout-session` creates real charges. This is not acceptable even in staging — Stripe webhooks fire on live mode from any endpoint.

## Downstream Impact

- VOY-1590 (Stripe E2E verification): blocked → blocked-on-test-keys → blocked-on-human
- VOY-1611 (Billing/pricing UI): can proceed independently (frontend renders tiers without hitting Stripe)
- VOY-1609 (Feature gating/paywall): blocked-on-billing-service → blocked-on-billing-commit → blocked-on-test-keys
- VOY-1613 (Test keys): blocked-on-human (Ben at Stripe dashboard)

## Recommendation to Team

1. **Founding Engineer**: Add the `PAPERCLIP_BILLING_ENABLED` gate to app.ts before committing the billing restore
2. **Staff Engineer**: VOY-1590 — verify billing service works with live keys in a read-only capacity (listTiers, getSubscription). Write tests that assert the gate behavior
3. **CTO**: Review the gate implementation and approve the billing restore commit
4. **Ben (Founder)**: Provide test-mode Stripe keys at earliest convenience