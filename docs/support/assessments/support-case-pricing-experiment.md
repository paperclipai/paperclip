# Support Case Assessment: M5 A/B Pricing Experiment

**Feature**: Server-side A/B pricing test — companies are deterministically assigned to variant A (control — current pricing) or variant B (treatment — adjusted lower pricing)
**Assessed by**: Support Engineer
**Date**: 2026-08-23
**Related**: VOY-1685, VOY-1886, VOY-1887, VOY-1888, VOY-1890
**Release**: M5 — A/B Pricing Test

## Feature Overview (User Perspective)

Paperclip now supports server-side A/B pricing experiments. Companies are deterministically assigned to either variant A (current pricing) or variant B (lower pricing) on first interaction with the pricing system. The assignment is permanent for each company and persists in the database.

**What this means for users:**

- **Some companies see different prices** — Depending on experiment assignment, a company may see lower pricing (variant B) or current pricing (variant A)
- **Experiment is configured server-side** — No user-facing toggle or UI. The experiment is enabled/disabled via environment variable
- **Assignment is deterministic** — A company always sees the same pricing, regardless of which device or browser they use
- **No action required from companies** — The experiment is transparent to end users within each company

### Variant B Pricing (Treatment)

| Tier | Monthly (Control) | Monthly (Treatment) | Yearly (Control) | Yearly (Treatment) |
|------|-------------------|--------------------|------------------|--------------------|
| Adventurer | $29 | $19 | $290/yr | $190/yr |
| Explorer | $79 | $69 | $790/yr | $690/yr |
| Elite | $199 | $179 | $1,990/yr | $1,790/yr |

## What Changed

### 1. Database Migration (`0230_pricing_experiment_columns.sql`)

Adds two columns to the `companies` table:
- `pricing_experiment_variant` (text) — stores 'A' or 'B' for the assigned variant
- `pricing_experiment_enrolled_at` (timestamptz) — timestamp of when the company was assigned

The migration is idempotent (`ADD COLUMN IF NOT EXISTS`) — re-running does not error.

### 2. Pricing Experiment Service (`server/src/services/pricing-experiment.ts`)

A new service that:
- Uses deterministic SHA-256 hash of `companyId + salt` to assign variants
- Parses experiment config from environment variable `PRICING_EXPERIMENT_CONFIG`
- Applies tier overrides for variant B
- Aggregates experiment results by variant

### 3. Billing Integration (`server/src/services/billing.ts`)

- `listTiers(companyId)` applies experiment overrides when returning available tiers
- `createCheckoutSession` includes `pricingExperimentVariant` in Stripe metadata for tracking

### 4. API Endpoints

- `GET /billing/experiment-variant` — Returns the assigned variant for the current company
- `GET /billing/experiment-results` — Returns per-variant enrollment counts and conversion stats (board-only)

## Known Limitations

1. **Variant assignment cannot be changed manually** — Once assigned, a company's variant is fixed. There is no admin UI or API to reassign a company.
2. **Experiment results are aggregate-only** — Individual company-level experiment data is not exposed via API.
3. **No automatic rollback** — If the experiment causes issues, it must be disabled via environment variable and a re-deploy.
4. **Stripe metadata includes variant** — Checkout sessions created during the experiment include `pricingExperimentVariant` in metadata, which remains even after the experiment ends.
5. **Traffic percent is config-wide** — The same `trafficPercent` applies to all companies. There is no per-tier or per-region targeting.
6. **Experiment config changes require re-deploy** — Changing the config (variants, weights, salt) requires updating the environment variable and re-deploying the server.

## Troubleshooting

### A company sees unexpected pricing
1. Check `companies.pricing_experiment_variant` in the database
2. If NULL, the company hasn't visited the pricing page since the experiment was enabled
3. If 'A', they see control pricing (expected)
4. If 'B', check that tier overrides are correctly configured in `PRICING_EXPERIMENT_CONFIG`
5. Verify the environment variable is set and the server was re-deployed after setting it

### Experiment appears disabled
1. Check that `PRICING_EXPERIMENT_CONFIG` environment variable is set with `"enabled": true`
2. Verify the server was re-deployed after setting the variable
3. Check server logs for `PRICING_EXPERIMENT_CONFIG` parse errors (log level: warn)

### Checkout session missing `pricingExperimentVariant`
1. Verify the company has been enrolled (check `pricing_experiment_variant` is not NULL)
2. This is non-critical — the metadata is informational only and does not affect the checkout flow

### 50/50 split seems off for small sample sizes
1. At low company counts, random variation is expected
2. Use the `GET /billing/experiment-results` endpoint to check aggregate counts
3. The split converges to configured weights as the sample size grows

## Escalation Path

| Issue | First Response | Escalation |
|-------|---------------|------------|
| Incorrect pricing displayed | Support Engineer verifies variant assignment and tier config | CTO — pricing service logic review |
| Experiment cannot be enabled | Support Engineer checks env var and deployment | Release Engineer — verify deployment |
| Strange experiment results | Support Engineer checks per-variant counts | CTO — data integrity review |
| Stripe checkout metadata issues | Support Engineer confirms variant persisted | CTO — billing integration review |

## Monitoring Checklist

- [ ] Server logs show no `PRICING_EXPERIMENT_CONFIG` parse errors
- [ ] Experiment variant endpoint returns expected values
- [ ] Experiment results endpoint shows non-zero counts for both variants
- [ ] New Stripe checkout sessions include `pricingExperimentVariant` metadata

## Rollback

To disable the experiment:
1. Remove or set `PRICING_EXPERIMENT_CONFIG={"enabled":false}` or remove the env var
2. Re-deploy the server
3. All companies will see control (variant A) pricing
4. Existing `pricing_experiment_variant` and `pricing_experiment_enrolled_at` data remains in the database
