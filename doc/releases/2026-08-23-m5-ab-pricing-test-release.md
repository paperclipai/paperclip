# Release: M5 A/B Pricing Test — VOY-1685 / VOY-1890

**Date:** 2026-08-23
**Release Engineer:** VOY-1890

## Scope

Deploy a server-side A/B pricing test for Paperclip. Companies are deterministically assigned to variant A (control — current pricing) or variant B (treatment — adjusted lower pricing) on first interaction with the pricing system.

### Variant B Pricing (Treatment)
| Tier | Monthly | Yearly | Change |
|------|---------|--------|--------|
| Adventurer | $19 | $190/yr | -$10/mo |
| Explorer | $69 | $690/yr | -$10/mo |
| Elite | $179 | $1,790/yr | -$20/mo |

## Implementation

- **Migration**: `0230_pricing_experiment_columns.sql` — adds `pricing_experiment_variant` (text) and `pricing_experiment_enrolled_at` (timestamptz) to `companies` table. Idempotent (`ADD COLUMN IF NOT EXISTS`).
- **Schema**: `packages/db/src/schema/companies.ts` — Drizzle columns added.
- **Service**: `server/src/services/pricing-experiment.ts` — deterministic SHA-256 variant assignment, config parsing (env var `PRICING_EXPERIMENT_CONFIG`), tier overrides, results aggregation.
- **Billing integration**: `server/src/services/billing.ts` — `listTiers(companyId)` applies experiment overrides; `createCheckoutSession` includes `pricingExperimentVariant` in Stripe metadata.
- **API endpoints**: `GET /billing/experiment-variant` (variant lookup), `GET /billing/experiment-results` (board-only stats).

## Enabling the Experiment

Set the environment variable on the target environment:

```json
PRICING_EXPERIMENT_CONFIG='{
  "enabled": true,
  "trafficPercent": 50,
  "variants": {
    "B": {
      "weight": 50,
      "tierOverrides": {
        "<adventurer-tier-id>": { "priceMonthlyCents": 1900, "priceYearlyCents": 19000 },
        "<explorer-tier-id>": { "priceMonthlyCents": 6900, "priceYearlyCents": 69000 },
        "<elite-tier-id>": { "priceMonthlyCents": 17900, "priceYearlyCents": 179000 }
      }
    }
  },
  "salt": "m5-pricing-experiment-v1"
}'
```

## Key Decisions
- Variant assignment is deterministic (SHA-256 hash of companyId + salt) — same company always gets the same variant.
- Assignment is persisted on the companies table on first pricing page visit.
- Experiment enabled/disabled via env var — no deploy needed to toggle.
- When disabled, all companies see control (variant A) pricing.
- Tier overrides are shallow merges — only overridden fields change.

## Review
- [x] Implementation (VOY-1685 / VOY-1886 / VOY-1887)
- [x] Code Review (VOY-1889 / VOY-1903)
- [x] Docs Verification — Support Engineer (VOY-1900)
- [x] CTO Sign-off

## QA
- [x] Deterministic assignment: same company_id → same variant (tested)
- [x] 50/50 distribution over N companies (tested)
- [x] Tier override application for variant B (tested)
- [x] Experiment disabled → normal tiers (tested)
- [ ] Checkout session metadata includes pricingExperimentVariant
- [ ] Migration idempotent: re-running does not error
- [ ] Rollback: remove columns, experiment stops

## Commit History
- `48e74146b9` — feat(billing): M5 A/B pricing experiment implementation (VOY-1685)
- `4560420bec` — feat(billing): M5 A/B pricing experiment — pricing page UX enhancements (VOY-1888)
- `8e2b5293c5` — docs(release): CTO sign-off granted for M5 A/B pricing test release
- `89b3030f76` — fix(db): add missing journal entry for 0230_pricing_experiment_columns migration
- `a3cd7bb88e` — test(shared): add unit tests for voyonder-bridge adapters
- `084747c520` — fix(analytics): use correct heartbeatRuns.agentId column instead of actorAgentId
- `25d841f802` — fix(analytics): rename retained to activeAgents in UsageAnalytics UI to match server column rename

## Status
- [x] Implementation
- [x] Code Review
- [x] CTO Sign-off
- [x] Docs Verification
- [ ] Ship to staging
- [ ] Verify staging
- [ ] Ship to production