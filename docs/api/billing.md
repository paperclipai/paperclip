---
title: Billing
summary: Stripe-integrated subscription management with tier plans, usage tracking, invoices, feature gating, and A/B pricing experiments
version: v0.5.0
last_updated: 2026-08-23
status: active
---

> ⚠️ **Feature-flagged:** Billing endpoints are mounted only when `PAPERCLIP_BILLING_ENABLED=true` is set. Without this flag, the routes are not registered and return 404.

The Billing API provides Stripe-integrated subscription management. Board users can list tiers, create/update/cancel subscriptions, report usage, sync invoices, and view a consolidated billing overview.

## Access Model

| Access Level | What they can do |
|---|---|
| **All company members** | Read endpoints: tiers, subscription, usage, invoices, overview |
| **Board users only** | All mutations: create/update/cancel/reactivate subscription, create checkout session, report usage, sync invoices |
| **Agents** | Read-only — all billing mutations return `403` for agents |

Every endpoint requires company access (`assertCompanyAccess`). Mutation endpoints additionally require a board-user context — agents are explicitly blocked with `403 Forbidden`.

## Configuration

Requires `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` environment variables. Without them, billing operations return errors.

## Endpoints

| Method | Path | Description | Access |
|---|---|---|---|
| `GET` | `/api/companies/{companyId}/billing/tiers` | List available subscription tiers (experiment-aware when pricing experiment is active) | All members |
| `GET` | `/api/companies/{companyId}/billing/subscription` | View current subscription | All members |
| `POST` | `/api/companies/{companyId}/billing/subscription` | Create a new subscription (direct — admin use) | Board user only |
| `PATCH` | `/api/companies/{companyId}/billing/subscription` | Update tier or billing period | Board user only |
| `POST` | `/api/companies/{companyId}/billing/create-checkout-session` | Create Stripe Checkout Session for card collection | Board user only |
| `POST` | `/api/companies/{companyId}/billing/subscription/cancel` | Cancel subscription (at period end) | Board user only |
| `POST` | `/api/companies/{companyId}/billing/subscription/reactivate` | Reactivate a subscription scheduled for cancellation | Board user only |
| `GET` | `/api/companies/{companyId}/billing/usage` | View billing-period usage | All members |
| `POST` | `/api/companies/{companyId}/billing/usage` | Report usage (seats, runs, storage) | Board user only |
| `GET` | `/api/companies/{companyId}/billing/invoices` | List invoices | All members |
| `POST` | `/api/companies/{companyId}/billing/invoices/sync` | Sync invoices from Stripe | Board user only |
| `GET` | `/api/companies/{companyId}/billing/overview` | Consolidated billing overview (subscription + usage + invoices) | All members |
| `GET` | `/api/companies/{companyId}/billing/experiment-variant` | Get the A/B pricing experiment variant assigned to this company | All members |
| `GET` | `/api/companies/{companyId}/billing/experiment-results` | Get A/B pricing experiment results summary | Board user only |
| `POST` | `/api/billing/webhook` | Stripe webhook receiver | Stripe signature verification only |

## Create or Update Subscription

```
POST /api/companies/{companyId}/billing/subscription
```

### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `tierId` | `string` (uuid) | yes | The tier to subscribe to |
| `billingPeriod` | `string` | no | `monthly` (default) or `yearly` |

### Response

`201 Created` with the subscription object.

## Create Checkout Session

```text
POST /api/companies/{companyId}/billing/create-checkout-session
```

Creates a Stripe Checkout Session (`mode: subscription`) so the customer can provide card details before the subscription is created. This is the recommended flow for new customers — it avoids `incomplete` subscriptions created by `stripe.subscriptions.create()` without a payment method.

### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `tierId` | `string` (uuid) | yes | The tier to subscribe to |
| `billingPeriod` | `string` | no | `monthly` (default) or `yearly` |
| `successUrl` | `string` (url) | no | Redirect after successful checkout. Defaults to `{PAPERCLIP_PUBLIC_URL}/boards/{companyId}` |
| `cancelUrl` | `string` (url) | no | Redirect when checkout is cancelled. Defaults to `{PAPERCLIP_PUBLIC_URL}/pricing` |

### Response

`200 OK` with the Checkout Session URL:

```json
{
  "url": "https://checkout.stripe.com/c/pay/cs_test_...",
  "sessionId": "cs_test_..."
}
```

The client should redirect the user to `url`. Stripe handles card collection, then fires the `checkout.session.completed` webhook, which creates the subscription in the database. If the user cancels checkout, they are returned to `cancelUrl` and no subscription is created.

## Update Subscription

```
PATCH /api/companies/{companyId}/billing/subscription
```

Same body as create — `tierId` (required) and `billingPeriod` (optional, defaults to `monthly`).

## Report Usage

```
POST /api/companies/{companyId}/billing/usage
```

### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `metric` | `string` | yes | One of `seats`, `agent_runs`, `storage_gb` |
| `quantity` | `integer` | yes | Non-negative quantity |

### Response

`201 Created` with the usage record. Usage resets at the start of each billing period (monthly = calendar month, yearly = calendar year).

## Stripe Webhook

```
POST /api/billing/webhook
```

This route runs **before** authentication middleware and relies on Stripe signature verification instead of bearer/auth. Requires the `stripe-signature` header and the raw request body. `STRIPE_WEBHOOK_SECRET` must match the Stripe dashboard webhook secret.

## Feature Gating

Billing routes are mounted only when `PAPERCLIP_BILLING_ENABLED=true`. In addition, the system enforces **feature gating** on several capabilities:

| Feature Key | What it gates | Paywall 403 message |
|---|---|---|
| `api_access` | Board-level API key creation | "Your current plan does not include API access" |
| `advanced_agents` | Creating certain agent types | Feature requires an upgraded plan |
| `unlimited_seats` | Inviting additional members beyond included count | "Your current plan is limited to N active members" |
| `custom_plugins` | Marketplace plugin installation | Feature requires an upgraded plan |

Feature-gated endpoints return `403` with `code: "PAYWALL"` in the error body, which the frontend can detect to show upgrade prompts.

## A/B Pricing Experiment (M5)

The system supports a server-side A/B pricing experiment. Companies are deterministically assigned to variant A (control — current pricing) or variant B (treatment — adjusted lower pricing) on first interaction with the pricing system.

### How It Works

1. A company visits the pricing page → `GET /billing/tiers`
2. The server checks the company's `pricing_experiment_variant` column
3. If unassigned, the company is deterministically assigned a variant (SHA-256 hash of company ID + salt)
4. The variant is persisted on the companies table — the same company always sees the same variant
5. Tier pricing is adjusted per variant before being returned

### Configuration

The experiment is controlled by the `PRICING_EXPERIMENT_CONFIG` environment variable (JSON):

```json
{
  "enabled": true,
  "trafficPercent": 50,
  "variants": {
    "B": {
      "weight": 50,
      "tierOverrides": {
        "<tier-id>": { "priceMonthlyCents": 1900, "priceYearlyCents": 19000 }
      }
    }
  },
  "salt": "m5-pricing-experiment-v1"
}
```

| Field | Description |
|---|---|
| `enabled` | Master switch — when `false`, all companies see control (variant A) pricing |
| `trafficPercent` | Percentage of new (unassigned) traffic to include in the experiment |
| `variants.B.weight` | Traffic weight for variant B within the experiment traffic |
| `variants.B.tierOverrides` | Partial tier overrides — only specified fields change; unspecified fields use the DB tier defaults |
| `salt` | Salt for deterministic assignment hash |

### Endpoints

#### Get Experiment Variant

```text
GET /api/companies/{companyId}/billing/experiment-variant
```

Returns the company's experiment variant and whether the experiment is enabled:

```json
{
  "variant": "A",
  "enabled": true
}
```

`variant` is `"A"`, `"B"`, or `null` (not yet assigned). Access: All company members.

#### Get Experiment Results

```text
GET /api/companies/{companyId}/billing/experiment-results
```

Returns per-variant enrollment counts and conversion stats. Access: Board users only.

### Edge Cases

| Scenario | Handling |
|---|---|
| Experiment disabled | Normal pricing, no variant assigned |
| Company already assigned | Existing variant reused — no reassignment |
| Variant B tier overrides not configured | No overrides applied; variant B sees control pricing |
| New company after experiment ends | No variant assigned, normal pricing |
| Checkout without variant metadata | Logged as warning; treated as variant A for reporting |

### Stripe Metadata

Checkout sessions created while the experiment is active include `pricingExperimentVariant` in Stripe metadata, enabling per-variant conversion analysis in the Stripe dashboard.

## Error Notes

| Error | HTTP Status | Cause |
|---|---|---|
| `403 Forbidden` | 403 | Actor is not a board user (agents always blocked on mutations) |
| `403 code: "PAYWALL"` | 403 | Company's subscription does not include the requested feature |
| `500` / billing operation error | 500 | Stripe configuration missing (`STRIPE_SECRET_KEY` not set) |

## Related Documentation

- [Billing Setup Guide](/guides/board-operator/billing-setup)
- [Paywall Errors KB](/support/kb/paywall-errors)
- [Billing Support Case Assessment](/support/assessments/support-case-billing-system)
