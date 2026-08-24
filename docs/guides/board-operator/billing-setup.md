---
title: Billing Setup
summary: Stripe-integrated subscription management for Paperclip companies — tier plans, Checkout flow, usage tracking, and invoices
version: v0.5.0
last_updated: 2026-08-21
status: active
---

> ⚠️ **Feature-flagged:** The billing system is gated behind `PAPERCLIP_BILLING_ENABLED=true`. Without this environment variable, billing routes are not registered and return 404.

Paperclip integrates with Stripe for subscription management. This guide walks you through connecting Stripe, understanding the available tiers, and managing your subscription.

## Prerequisites

- A **Stripe account** (you can [create one free](https://stripe.com))
- **Admin access** to the Stripe dashboard
- **Board user access** on the Paperclip company (billing mutations are board-user-only)

## Step 1: Get Your Stripe Keys

1. Log in to the [Stripe Dashboard](https://dashboard.stripe.com)
2. Go to **Developers → API Keys**
3. Copy your **Secret key** (starts with `sk_live_` or `sk_test_`)
4. Go to **Developers → Webhooks** and **Add endpoint**
   - Endpoint URL: `https://your-paperclip-instance.com/api/billing/webhook`
   - Events to send: `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`
5. Copy the **Webhook signing secret** (starts with `whsec_`)

## Step 2: Configure Environment Variables

Set these environment variables on your Paperclip server:

| Variable | Description |
|----------|-------------|
| `STRIPE_SECRET_KEY` | Your Stripe secret key (`sk_live_...` or `sk_test_...`) |
| `STRIPE_WEBHOOK_SECRET` | Your Stripe webhook signing secret (`whsec_...`) |

For local development, add them to your `.env` file:

```sh
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

For production, set them in your deployment environment (Docker, Kubernetes, etc.).

> **Without these keys**, billing operations return errors. The server starts fine, but billing endpoints will not function.

## Step 3: Understand Subscription Tiers

Paperclip supports multiple subscription tiers. Each tier defines:

| Field | Description |
|-------|-------------|
| **Name** | Display name (e.g., "Starter", "Professional", "Enterprise") |
| **Price** | Monthly or yearly price in cents |
| **Features** | Included capabilities (e.g., seat count, agent runs, storage) |
| **Limits** | Usage caps per billing period |

List available tiers via the API or board UI:

```
GET /api/companies/{companyId}/billing/tiers
```

## Step 4: Create a Subscription

Once Stripe is connected and tiers are configured, a board user can create a subscription:

1. Go to the **Billing** page from the company dashboard
2. Click **Choose a plan**
3. Select a tier and billing period (monthly/yearly)
4. Review the Stripe checkout and complete payment

Or via the API:

```sh
curl --fail-with-body -sS -X POST /api/companies/{companyId}/billing/subscription \
  -H "Authorization: Bearer $PAPER..._KEY" \
  -H "Content-Type: application/json" \
  -d '{"tierId": "tier-uuid", "billingPeriod": "monthly"}'
```

## Managing Your Subscription

### Change Tier

Upgrade or downgrade at any time. Changes take effect immediately with prorated billing.

```sh
curl --fail-with-body -sS -X PATCH /api/companies/{companyId}/billing/subscription \
  -H "Authorization: Bearer $PAPER..._KEY" \
  -H "Content-Type: application/json" \
  -d '{"tierId": "new-tier-uuid"}'
```

### Cancel Subscription

Cancellation takes effect at the end of the current billing period. You retain access until then.

```sh
curl --fail-with-body -sS -X POST /api/companies/{companyId}/billing/subscription/cancel \
  -H "Authorization: Bearer ***"
```

### Reactivate Subscription

Reactivate a subscription that's scheduled for cancellation before the period ends.

```sh
curl --fail-with-body -sS -X POST /api/companies/{companyId}/billing/subscription/reactivate \
  -H "Authorization: Bearer ***"
```

### View Usage

Monitor your billing-period usage:

```
GET /api/companies/{companyId}/billing/usage
```

Usage metrics tracked:
| Metric | Description |
|--------|-------------|
| `seats` | Active board user seats |
| `agent_runs` | Agent heartbeat executions |
| `storage_gb` | Storage consumed (documents, artifacts, etc.) |

### View Invoices

Access your invoice history:

```
GET /api/companies/{companyId}/billing/invoices
```

Sync invoices from Stripe manually:

```sh
curl --fail-with-body -sS -X POST /api/companies/{companyId}/billing/invoices/sync \
  -H "Authorization: Bearer ***"
```

## Security Notes

- **Billing mutations are board-user only** — agents cannot create, modify, or cancel subscriptions. Any agent attempt returns `403 Forbidden`.
- **Stripe webhook** uses signature verification (`stripe-signature` header) — no bearer token is required for the webhook endpoint.
- **The webhook endpoint** (`/api/billing/webhook`) runs before authentication middleware, so the raw request body is available for signature verification.

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Billing operations return errors | `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET` not set | Add the missing environment variable |
| Webhook not receiving events | Stripe webhook endpoint URL incorrect | Verify the URL in Stripe Dashboard → Developers → Webhooks |
| `403 Forbidden` on mutation | Caller is an agent, not a board user | Use a board user session or API key |
| Proration not as expected | Stripe default behavior | Check Stripe dashboard for proration details |

## Related

- [Billing API Reference](/api/billing)
- [Notifications Configuration](/guides/board-operator/notification-configuration)
- [Costs & Budgets](/guides/board-operator/costs-and-budgets)