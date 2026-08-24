|---
title: VOY-1609 — Feature Gating / Paywall Middleware
version: v0.5.0
date: 2026-08-20
commit: 63dbac23e8
status: Released (PR #66 merged)
---

# Release: VOY-1609 — Feature Gating / Paywall Middleware

**Release:** v0.5.0 (Market Readiness) — shipped as part of PR #66
**Commits:** `63dbac23e8` (also includes period boundary fix + E2E verification)
**Date:** 2026-08-20 (initial), 2026-08-22 (period boundary fix)
**Status:** Released

## Summary

Adds a `requireFeature` middleware and `checkFeatureAccess` service that gates operations behind subscription tier features. When a company tries to use a feature not included in its current plan, the server responds with a `403 Forbidden` and error code `PAYWALL`.

This is the foundation of Paperclip's subscription-based feature control — every gated operation is checked against the company's active subscription tier before proceeding.

## How It Works

### Architecture

```
Route handler
  └─ requireFeature(db, "api_access")        // Express middleware
       └─ billing.requireFeature(companyId, featureKey)
            └─ billing.checkFeatureAccess(companyId, featureKey)
                 ├─ 1. If feature is FREE_FEATURES → always allowed
                 ├─ 2. If no subscription → denied (except free features)
                 ├─ 3. If subscription inactive → denied
                 ├─ 4. If canceled at period end and period elapsed → denied
                 └─ 5. If tier.features includes featureKey → allowed
```

### Feature Keys

| Key | Gated Operations | Free? |
|-----|-----------------|-------|
| `custom_plugins` | Installing marketplace plugins | ✅ Yes |
| `advanced_agents` | Creating AI agents beyond free limit | ❌ No |
| `api_access` | Creating board-level API keys | ❌ No |
| `unlimited_seats` | Inviting members beyond seat limit | ❌ No |
| `audit_logs` | Audit log export and search | ❌ No |
| `priority_support` | Priority support SLA | ❌ No |
| `extended_storage` | Extended per-company storage | ❌ No |
| `sso` | SAML/SSO authentication | ❌ No |
| `custom_roles` | Custom role definitions | ❌ No |
| `advanced_reporting` | Advanced analytics dashboard | ❌ No |

### Currently Gated Routes

1. **API Key Creation** — `POST /api/companies/:id/access/keys` checks `api_access`
2. **Agent Creation** — Agent creation route checks `advanced_agents`
3. **Member Invites** — `POST /api/companies/:id/invites` checks `unlimited_seats` and enforces seat limits
4. **Plugin Installation** — Marketplace plugin installation checks `custom_plugins` (free feature)

### Error Response

```json
{
  "error": "Forbidden",
  "status": 403,
  "code": "PAYWALL",
  "message": "This feature is not included in your current plan (Starter).",
  "featureKey": "api_access",
  "tierName": "Starter"
}
```

## Changes

### New Files

- `server/src/middleware/require-feature.ts` — Express middleware factory
- `server/src/__tests__/billing-feature-gate.test.ts` — Unit tests for `checkFeatureAccess` and `requireFeature` with embedded Postgres

### Modified Files

- `server/src/services/billing.ts` — Added `checkFeatureAccess` and `requireFeature` methods (lines 539–640)
- `server/src/routes/agents.ts` — Gated agent creation behind `advanced_agents`
- `server/src/routes/access.ts` — Gated API key creation behind `api_access` and invite creation behind `unlimited_seats`

### Shared Package

- `packages/shared/src/billing-features.ts` — `FEATURE_KEYS`, `FREE_FEATURES`, and `ACTIVE_SUBSCRIPTION_STATUSES` constants

## Configuration

No new environment variables. Feature gating is active when billing is enabled (`PAPERCLIP_BILLING_ENABLED=true`). When billing is disabled, `requireFeature` passes through — all features are effectively free.

## Related Documentation

- [PAYWALL Errors KB](/support/kb/paywall-errors) — Troubleshooting guide for 403 Paywall errors
- [Billing System Support Assessment](/support/assessments/support-case-billing-system)
- [Billing Setup Guide](/guides/board-operator/billing-setup)

## Migration Notes

- Migration 0137 adds `subscription_tiers.features` (JSONB array) column
- Existing tiers must have their `features` array populated — migrations seed default feature sets
- See [Billing Setup Guide](/guides/board-operator/billing-setup) for tier configuration
