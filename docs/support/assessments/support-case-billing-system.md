# Support Case Assessment: Billing System — Subscriptions, Usage, and Invoicing

> ⚠️ **Feature-flagged:** Billing is gated behind `PAPERCLIP_BILLING_ENABLED=true`. Without this flag, billing routes are not registered. See [Billing Setup](/guides/board-operator/billing-setup) for configuration.
>
> **Upstream-compatible restoration** (VOY-1611, commit `1fb17b8f18`): The billing implementation has been restored with upstream-compatible code. API contracts are unchanged from the previous fork-specific implementation. This assessment has been updated to reflect the restored code.

**Feature**: Stripe-integrated billing with subscription management, usage tracking, invoice syncing, and board-user-only mutation controls
**Assessed by**: Support Engineer
**Date**: 2026-08-23
**Related**: VOY-1364, VOY-1367, VOY-944, VOY-896, VOY-905, VOY-1669, VOY-1673, VOY-1685, VOY-1888
**Release**: v0.4.0-alpha (hotfix VOY-1367) + P1-2 TOCTOU fix (VOY-1669) + M5 A/B pricing experiment (VOY-1685/VOY-1888)

## Feature Overview (User Perspective)

The Billing System provides Stripe-integrated subscription management for Voyonder companies. Board users (human operators with board access) can manage subscription tiers, view usage, and sync invoices.

**What users can do:**

- **View available subscription tiers** — See a list of available plans with pricing and features
- **Manage subscriptions** — Create a new subscription (choosing tier and monthly/yearly billing), update the tier or billing period, cancel, and reactivate
- **Track usage** — View current billing-period usage metrics (seats, agent runs, storage)
- **Report usage** — Board users can report usage for metered billing (seats, agent_runs, storage_gb)
- **View and sync invoices** — See Stripe invoice history and trigger a sync from Stripe to update the local invoice records
- **View billing overview** — A consolidated view of current subscription, usage, and recent invoices

**Security boundary (VOY-1364 B1 fix):**
- **Read routes** (viewing tiers, subscription, usage, invoices, overview) are accessible to agents — no charges can be created from read-only access
- **Mutation routes** (creating/updating/canceling/reactivating subscriptions, reporting usage, syncing invoices) require a **board user** — agents are explicitly blocked with 403
- Stripe **webhooks** use signature verification instead of bearer auth

## What Changed

### New billing endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/companies/:companyId/billing/tiers` | Any company member | List subscription tiers |
| `GET` | `/api/companies/:companyId/billing/subscription` | Any company member | Get current subscription |
| `POST` | `/api/companies/:companyId/billing/subscription` | Board user only | Create subscription (tier + billing period — direct admin use) |
| `POST` | `/api/companies/:companyId/billing/create-checkout-session` | Board user only | Create Stripe Checkout Session for card collection before subscription |
| `PATCH` | `/api/companies/:companyId/billing/subscription` | Board user only | Update tier/billing period |
| `POST` | `/api/companies/:companyId/billing/subscription/cancel` | Board user only | Cancel subscription |
| `POST` | `/api/companies/:companyId/billing/subscription/reactivate` | Board user only | Reactivate cancelled subscription |
| `GET` | `/api/companies/:companyId/billing/usage` | Any company member | View billing-period usage |
| `POST` | `/api/companies/:companyId/billing/usage` | Board user only | Report usage (seats, agent_runs, storage_gb) |
| `GET` | `/api/companies/:companyId/billing/invoices` | Any company member | List invoices |
| `POST` | `/api/companies/:companyId/billing/invoices/sync` | Board user only | Sync invoices from Stripe |
| `GET` | `/api/companies/:companyId/billing/overview` | Any company member | Consolidated billing overview |
| `POST` | `/api/billing/webhook` | Stripe signature | Stripe webhook receiver |

### Checkout Session flow (new)

`POST /api/companies/:companyId/billing/create-checkout-session` creates a Stripe Checkout Session (`mode: subscription`) so the customer provides card details **before** the subscription is created. This is the recommended flow for new customers — it avoids `incomplete` subscriptions that result from `stripe.subscriptions.create()` without a payment method.

The response returns `{ "url": "...", "sessionId": "..." }`; the client redirects the user to `url`. Stripe handles card collection, then fires `checkout.session.completed`, which creates the subscription in the database. If the user cancels checkout, they are returned to `cancelUrl` (defaults to `{PAPERCLIP_PUBLIC_URL}/pricing`) and no subscription is created.

Supported request fields: `tierId` (required), `billingPeriod` (optional, defaults to `monthly`), `successUrl` and `cancelUrl` (optional URLs).

### Billing periods

Subscriptions support two billing periods:
- **`monthly`** — Calendar-month periods (1st to 1st)
- **`yearly`** — Calendar-year periods (Jan 1 to Jan 1)

### Usage metrics

| Metric | Description |
|--------|-------------|
| `seats` | Number of active user seats |
| `agent_runs` | Count of agent execution runs |
| `storage_gb` | Storage consumption in gigabytes |

### New schema tables

| Table | Purpose |
|-------|---------|
| `subscription_tiers` | Available plans (name, price, billing period, features) |
| `stripe_customers` | Company-to-Stripe-customer mapping |
| `company_subscriptions` | Active subscriptions per company |
| `subscription_invoices` | Invoice records synced from Stripe |
| `subscription_usage` | Metered usage records per billing period |

### Environment configuration

| Variable | Required? | Description |
|----------|-----------|-------------|
| `STRIPE_SECRET_KEY` | Required for billing operations | Stripe API secret key |
| `STRIPE_WEBHOOK_SECRET` | Required for webhook verification | Stripe webhook signing secret |

If `STRIPE_SECRET_KEY` is not set, billing operations return an error — all endpoints remain available but will fail. Webhook routes mount regardless.

## Potential User Confusion Points

1. **"I can't create/cancel a subscription — I keep getting a 403"** — Subscription mutations require a **board user** context (a human with board access). Agents cannot create or modify subscriptions. Ensure the API key or session belongs to a board user.

2. **"I created a subscription but nothing happened on Stripe"** — Check `STRIPE_SECRET_KEY` is set in the server environment. If it's missing, billing operations fail with a clear error. Also verify the selected `tierId` is a valid UUID from the tiers list.

3. **"My invoices are missing or out of date"** — Invoices are synced from Stripe. Use `POST /billing/invoices/sync` to trigger a manual sync. Invoices appear only after they are finalized in Stripe.

4. **"Usage data shows zero"** — Usage is tracked per billing period. Usage from previous periods does not carry over. Usage can be reported manually via `POST /billing/usage` (board user only).

5. **"What's the difference between cancel and the subscription just expiring?"** — Cancellation immediately marks the subscription as cancelled. Reactivation (`POST /billing/subscription/reactivate`) can restore a cancelled subscription.

6. **"I changed my plan but the price looks wrong"** — Verify the tier's `billingPeriod` matches expectations. Tiers may have different prices for monthly vs yearly billing. Use `GET /billing/tiers` to see current pricing.

7. **"Billing webhook errors in logs"** — Check that `STRIPE_WEBHOOK_SECRET` matches the endpoint secret configured in the Stripe dashboard. The webhook endpoint is mounted at `POST /api/billing/webhook`.

8. **"I completed Stripe checkout but no subscription was created"** — The `checkout.session.completed` webhook creates the subscription. Verify the webhook endpoint (`POST /api/billing/webhook`) is configured in the Stripe dashboard and `STRIPE_WEBHOOK_SECRET` is correct. If the user cancelled checkout, no subscription is created — that's expected.

9. **"Checkout Session URL doesn't return to where I expected"** — `successUrl` and `cancelUrl` default to `{PAPERCLIP_PUBLIC_URL}/boards/{companyId}` and `{PAPERCLIP_PUBLIC_URL}/pricing` respectively. Custom URLs must be valid absolute URLs.

## Auto-Notifications

When budget thresholds are crossed (via the budgets service), the notification system automatically sends **budget_threshold** notifications to all active human members. This covers both soft (warning) and hard limit breaches, including the dollar amounts and scope details.

See the [Notification System Support Case Assessment](support-case-notification-system.md) for notification behavior details.

## Feature Gating — PAYWALL Errors (New)

The billing restoration (VOY-1611, commit `1fb17b8f18`) adds a **feature gating** system. Certain routes now check whether the company's subscription tier includes the required feature before allowing the operation. If the feature is not included, the endpoint returns `403` with `code: "PAYWALL"`.

### Gated Features

| Feature Key | Routes Gated | Trigger |
|---|---|---|
| `api_access` | `POST /api/companies/:id/access/keys` — board-level API key creation | Any API key creation attempt |
| `advanced_agents` | `POST /api/companies/:id/agents` — agent creation | Agent creation via API or UI |
| `unlimited_seats` | `POST /api/companies/:id/invites` — member invites | Inviting when seat count exceeds tier's `includedSeats` |
| `custom_plugins` | Marketplace plugin installation | Plugin installation attempt |

### Support Scenarios

| Scenario | What the user sees | Root Cause | Resolution |
|---|---|---|---|
| "I get a PAYWALL error when creating an API key" | `403 { code: "PAYWALL", message: "Your current plan does not include API access" }` | The company's subscription tier does not include the `api_access` feature | Upgrade to a tier that includes API access |
| "I can't invite new team members" | `403 { code: "PAYWALL", message: "Your current plan is limited to N active members" }` | Company has reached its included seat count; `unlimited_seats` feature not in tier | Upgrade to a tier with more seats or unlimited_seats |
| "I can't create an agent" | `403 { code: "PAYWALL" }` | The company's subscription tier does not include `advanced_agents` | Upgrade to a tier that includes advanced agents |
| "I can't install a plugin from the marketplace" | `403 { code: "PAYWALL" }` | The company's subscription tier does not include `custom_plugins` | Upgrade to a tier with plugin support |

### Frontend Behavior

The pricing page (`/pricing`) detects `code: "PAYWALL"` in error responses and can display upgrade prompts. The `paywall()` error function in `server/src/errors.ts` optionally accepts `featureKey`, `tierName`, and `requiredPlan` in the details object for richer upgrade messaging.

### Detection

Support can verify feature gate status by checking the company's subscription tier:

```sql
SELECT ct.name, ct.features, cs.status
FROM company_subscriptions cs
JOIN subscription_tiers ct ON ct.id = cs.tier_id
WHERE cs.company_id = '<company-id>';
```

The `features` column is a JSONB array of feature keys. If the required feature key is missing, the gate fires.

## A/B Pricing Experiment Support (M5)

An A/B pricing experiment (VOY-1685/VOY-1888) has been implemented. Companies are deterministically assigned to variant A (control — current pricing) or variant B (treatment — adjusted lower pricing) on first interaction with the pricing system.

### What Changed

- **Two new endpoints**: `GET /billing/experiment-variant` (variant lookup, all members) and `GET /billing/experiment-results` (board-only results summary)
- **Modified endpoint**: `GET /billing/tiers` now returns experiment-aware pricing when the experiment is active
- **Stripe metadata**: Checkout sessions carry `pricingExperimentVariant` for per-variant conversion tracking in Stripe dashboard
- **New env var**: `PRICING_EXPERIMENT_CONFIG` (JSON) controls experiment parameters — no deploy needed to toggle

### Potential User Confusion Points

1. **"I see different prices than my teammate"** — This is expected. The A/B experiment assigns different companies to different pricing variants deterministically. Both see prices appropriate to their assigned variant.

2. **"The pricing changed on my page"** — The experiment is deterministic per company. Once assigned, a company always sees the same variant. Pricing doesn't change mid-session.

3. **"I was in variant B but now I see variant A pricing"** — The experiment may have been disabled via config change. When disabled, all companies see control (variant A) pricing regardless of assignment.

4. **"My Stripe checkout shows experiment metadata"** — This is intentional. `pricingExperimentVariant` is included in checkout session metadata for conversion analysis.

### Known Limitations

1. **Variant B overrides require valid tier IDs**: The `PRICING_EXPERIMENT_CONFIG` must reference valid subscription tier UUIDs in `tierOverrides`. Invalid tier IDs are silently ignored.
2. **No mid-experiment rebalancing**: Once a company is assigned to a variant, they stay in that variant. There is no mechanism to rebalance mid-experiment.
3. **Results endpoint is basic**: `GET /experiment-results` returns enrollment counts and conversion stats only. Detailed funnel analysis requires Stripe dashboard or PostHog.
4. **Stale assignments after experiment ends**: Previously assigned companies retain their variant column value, but it has no effect when the experiment is disabled.

### Support Escalation Path

| Issue | Severity | Action |
|---|---|---|
| Experiment not activating (all seeing control pricing) | Medium | Verify `PRICING_EXPERIMENT_CONFIG` is set correctly with `"enabled": true`. Check server logs for config parse errors. |
| Variant B shows same prices as variant A | Medium | Check `tierOverrides` in config — ensure tier IDs match the actual tier UUIDs from the DB. |
| Experiment-results endpoint returns empty | Low | Results return data only after at least one company has been assigned a variant. |

## Live Events — Real-Time Subscription Status

The billing system emits `subscription.status.updated` live events whenever a subscription's status changes. These events are delivered to the UI via WebSocket (no polling needed) and cause the subscription and billing-overview views to refresh automatically.

### Events emitted

| Trigger | Event Type | `status` in Payload | Source |
|---------|-----------|---------------------|--------|
| Invoice payment fails | `subscription.status.updated` | `past_due` | Stripe webhook `invoice.payment_failed` |
| Subscription updated (tier/status change) | `subscription.status.updated` | Mirrors Stripe subscription status | Stripe webhook `customer.subscription.updated` |
| Subscription deleted/canceled in Stripe | `subscription.status.updated` | `canceled` | Stripe webhook `customer.subscription.deleted` |
| Checkout session completed | `subscription.status.updated` | Mirrors Stripe subscription status | Stripe webhook `checkout.session.completed` |
| Board user creates subscription (admin) | `subscription.status.updated` | Mirrors Stripe subscription status | `POST /billing/subscription` |
| Board user updates tier/billing period | `subscription.status.updated` | Mirrors Stripe subscription status | `PATCH /billing/subscription` |
| Board user cancels subscription | `subscription.status.updated` | Current status (cancelAtPeriodEnd=true) | `POST /billing/subscription/cancel` |
| Board user reactivates subscription | `subscription.status.updated` | Current status (cancelAtPeriodEnd=false) | `POST /billing/subscription/reactivate` |

### Payload shape

```json
{
  "id": 42,
  "companyId": "uuid",
  "type": "subscription.status.updated",
  "createdAt": "2026-08-21T19:19:30.000Z",
  "payload": {
    "status": "active",
    "stripeSubscriptionId": "sub_xxx",
    "cancelAtPeriodEnd": false,
    "tierId": "uuid-or-null"
  }
}
```

### What support should know

- **The UI updates automatically.** If a customer reports stale billing data on the subscription or overview page, a WebSocket reconnect or page refresh forces a full re-fetch. The live event system is best-effort — if the WebSocket connection was dropped, the UI refreshes on next connect or manual refresh.
- **No customer action required.** Status propagation is silent — users see updated subscription state without any action.
- **Troubleshooting:** If the UI is not updating, check that WebSocket connections are established (`/api/realtime/live-events`). The live event system uses in-process EventEmitter — if the server process is healthy, events are dispatched. No additional configuration needed beyond the standard live-events WebSocket setup.

## Known Limitations (Restored Code)

1. **P1: Webhook idempotency** — ✅ **FIXED** (committed `1fb17b8f18`). Migration 0228 adds `stripe_webhook_events` dedup table with `UNIQUE(stripe_event_id)`. Webhook handler inserts event ID before processing; 23505 duplicate violation → silently skip. UNIQUE indexes on `stripe_invoice_id` and `stripe_customers.company_id` also applied.
2. **P1: Race in handleSubscriptionUpdated / handleCheckoutSessionCompleted** — ✅ **FIXED** (committed `1fb17b8f18`). Uses `INSERT ... ON CONFLICT (stripe_subscription_id) DO UPDATE SET` — concurrent Stripe events are idempotent.
3. ✅ **P1-2: TOCTOU in createOrUpdateSubscription** — **FIXED** (committed `b840497fab`, VOY-1669). The SELECT-then-INSERT race window in `createOrUpdateSubscription` is eliminated. The INSERT now uses `ON CONFLICT (company_id) DO NOTHING`; if the race is lost, the orphan Stripe subscription is cancelled and the winner's record is returned. The UPDATE path now uses `companyId` for the WHERE clause instead of a potentially stale `existingSub.id`. Both Stripe create and update paths are wrapped in `withStripeRetry` for resilience against transient Stripe API failures.
4. ✅ **P2: reportUsage read-then-write race** — **FIXED** (committed `b840497fab`, VOY-1669). The `reportUsage` endpoint no longer does a separate SELECT-then-INSERT/UPDATE. It uses `INSERT ... ON CONFLICT DO UPDATE` (upsert) on the unique constraint `(subscription_id, metric, period_start, period_end)`, making concurrent usage reports safe. The `stripe.subscriptionItems.createUsageRecord()` call is now wrapped in `withStripeRetry`.
5. ✅ **P2: No real-time subscription status propagation** — **RESOLVED** (committed `b8732268f2`). All 8 subscription state transitions now emit `subscription.status.updated` live events via `publishLiveEvent`. The UI handler in `LiveUpdatesProvider` invalidates subscription and overview caches on receipt, so the UI updates immediately without manual refresh. See [Live Events Reference](#live-events) below.
6. **P2: Zero test coverage** on webhook handlers, checkout flow, cancel/reactivate, invoice sync. 🟡 **Partially addressed** by concurrent billing concurrency test suite (commit `e5a8217f8e`, 7 tests covering FOR UPDATE serialisation, ON CONFLICT upsert, ON CONFLICT DO NOTHING, 5-concurrent usage upserts, unique constraint safety net). Webhook/checkout/invoice-sync handlers still lack dedicated tests.
7. **P2-1: Transaction wrapping for webhook handlers** — ✅ **FIXED** (committed `151f0a2066`, VOY-1669). `handleInvoicePaymentFailed` and `handleSubscriptionDeleted` are now wrapped in `db.transaction()`. The UPDATE + live-event publish are now atomic. This matches the pattern already used by `handleInvoicePaid` and `handleSubscriptionUpdated`.
8. ✅ **VOY-1687: Idempotency key on stripe.subscriptions.create()** — **FIXED** (committed `cd74f15ca8`). The `stripe.subscriptions.create()` call in `createOrUpdateSubscription` now passes an idempotency key (`createOrUpdateSubscription:create:{companyId}:{tierId}`). This prevents orphan subscriptions when the Stripe API call succeeds but the HTTP response is lost and `withStripeRetry` retries. No more double-billing risk from network blips during subscription creation.
9. **No subscription tier seed data** in committed code — tiers must be seeded manually or via a bootstrap script.
10. **Feature-flagged** — All billing routes are gated behind `PAPERCLIP_BILLING_ENABLED=true` (disabled by default).

## Support Escalation Path

| Issue | Severity | Action |
|---|---|---|
| Subscription create fails with Stripe API error | Critical | Check Stripe dashboard for account status; verify `STRIPE_SECRET_KEY` is valid and has correct permissions |
| Checkout session creation fails | Critical | Verify `STRIPE_SECRET_KEY` is set and has `checkout.session.create` permission. Check that the requested `tierId` exists |
| `checkout.session.completed` webhook not processed | High | Check webhook signing secret; verify Stripe dashboard webhook endpoint URL is `POST /api/billing/webhook`; check raw body availability on the request |
| Billing webhook not processing events | High | Verify webhook signing secret; check Stripe dashboard for failed webhook deliveries |
| Invoice sync fails or returns empty | High | Check Stripe dashboard for invoice existence; verify the Stripe customer is correctly linked |
| Agent receives 403 on billing mutations | Low | Expected behavior — agents cannot mutate billing. Educate user that a board user must perform billing actions |
| "Missing raw body for webhook verification" | High | Webhook endpoint expects `rawBody` to be available on the request object. Ensure the Express raw body parser is configured before the webhook route |
| Usage reporting discrepancy | Medium | Verify the billing period alignment and metric name. Usage is reset at the start of each billing period |

## Related Documentation

- [Notification System Support Case Assessment](support-case-notification-system.md)
- [Stripe Billing Robustness Fixes Support Case Assessment](support-case-stripe-billing-fixes.md)
- [Stripe Tier Sync Hardening Support Case Assessment](support-case-stripe-tier-sync.md)
- [v0.4.0-alpha Release Notes](../releases/v0.4.0-alpha-deep-planning.md)