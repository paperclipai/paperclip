---
title: Support KB — PAYWALL 403 Errors (Feature Gating)
summary: Understanding and resolving 403 PAYWALL errors when features are restricted by subscription tier
version: v0.5.0
commit: 1fb17b8f18
---

# Support KB: PAYWALL 403 Errors (Feature Gating)

> ⚠️ **Feature-flagged:** The feature gating system requires `PAPERCLIP_BILLING_ENABLED=true` and active Stripe billing configuration.

## What is a PAYWALL error?

A **PAYWALL** error is a `403 Forbidden` with `code: "PAYWALL"` in the response body. It means the action you're trying to perform requires a subscription feature that your current plan does not include.

Example response:

```json
{
  "error": "Forbidden",
  "status": 403,
  "code": "PAYWALL",
  "message": "Your current plan does not include API access"
}
```

## Which operations can return PAYWALL?

| Operation | Feature Key Required | Typical Error Message |
|---|---|---|
| Creating a board-level API key | `api_access` | "Your current plan does not include API access" |
| Creating certain agent types | `advanced_agents` | "Feature requires an upgraded plan" |
| Inviting members beyond seat limit | `unlimited_seats` | "Your current plan is limited to N active members" |
| Installing marketplace plugins | `custom_plugins` | "Feature requires an upgraded plan" |

## What triggers a PAYWALL?

1. **API Key Creation** — `POST /api/companies/:id/access/keys` checks the `api_access` feature key. Any company whose subscription tier lacks `api_access` will get PAYWALL when trying to create a board-level API key.

2. **Agent Creation** — `POST /api/companies/:id/agents` checks the `advanced_agents` feature key. Companies on tiers without advanced agent support cannot create new agents.

3. **Member Invites** — `POST /api/companies/:id/invites` checks `unlimited_seats`. If the tier does not include `unlimited_seats`, the system counts current active members and compares against the tier's `includedSeats` value. If at or above the limit, the invite is blocked.

4. **Plugin Installation** — Marketplace plugin installation checks `custom_plugins`. Without this feature, plugins cannot be installed.

## How to resolve

1. **Check your current plan** — Go to the Billing page (`/pricing`) to see your subscription tier and included features.
2. **Upgrade your plan** — Choose a tier that includes the feature you need. The tier comparison on the pricing page shows which features each tier includes.
3. **If you believe you have access** — Contact support. We can verify your subscription tier against the expected feature set using the billing database.

## How support can investigate

Verify the company's subscription tier features:

```sql
SELECT ct.name AS tier_name, ct.features, cs.status
FROM company_subscriptions cs
JOIN subscription_tiers ct ON ct.id = cs.tier_id
WHERE cs.company_id = '<company-id>';
```

The `features` column is a JSONB array. Check if the required feature key is present:

```sql
SELECT ct.name, ct.features @> ARRAY['api_access']::text[] AS has_api_access
FROM subscription_tiers ct
JOIN company_subscriptions cs ON cs.tier_id = ct.id
WHERE cs.company_id = '<company-id>';
```

If `has_api_access` is `false`, the gate is working correctly — the tier genuinely lacks that feature.

## Related

- [Billing API Reference](/api/billing)
- [Billing Setup Guide](/guides/board-operator/billing-setup)
- [Billing Support Case Assessment](/support/assessments/support-case-billing-system)