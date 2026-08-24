# M5: Deploy A/B Pricing Test — Technical Execution Plan

**Owner:** CTO
**Parent:** VOY-1801
**Date:** 2026-08-23

---

## 1. Overview

Deploy a server-side A/B pricing test for Paperclip (Voyonder). Companies are deterministically assigned to variant A (control — current pricing) or variant B (treatment — adjusted pricing structure) on first interaction with the pricing system. Conversion is tracked via Stripe checkout metadata and an internal experiment assignment table.

**Goal:** Determine which pricing structure drives higher conversion from signup → paid subscription.

---

## 2. Variant Design

### Variant A (Control) — Current Pricing

| Tier | Monthly | Yearly | Seats | Agent Runs/mo | Storage |
|------|---------|--------|-------|---------------|--------|
| Adventurer | $29 | $290/yr | 2 | 500 | 5 GB |
| Explorer | $79 | $790/yr | 5 | 2000 | 25 GB |
| Elite | $199 | $1,990/yr | 20 | 10000 | 100 GB |

### Variant B (Treatment) — Adjusted Pricing

Lower entry price + rebalanced mid tier to reduce friction:

| Tier | Monthly | Yearly | Seats | Agent Runs/mo | Storage | Changes |
|------|---------|--------|-------|---------------|---------|---------|
| Adventurer | $19 | $190/yr | 2 | 500 | 5 GB | -$10/mo (lower barrier) |
| Explorer | $69 | $690/yr | 5 | 2000 | 25 GB | -$10/mo |
| Elite | $179 | $1,790/yr | 20 | 10000 | 100 GB | -$20/mo |

**Rationale:** Lower entry price ($19) reduces signup friction. Moderate reductions on upper tiers maintain perceived value while improving conversion.

> **Note:** Pricing numbers are initial proposals. CEO/COO can adjust via config without code changes.

---

## 3. Architecture

### 3.1 Data Model

Add two columns to `companies` table:
- `pricing_experiment_variant` (text, nullable) — `null` (not assigned), `'A'` (control), `'B'` (treatment)
- `pricing_experiment_enrolled_at` (timestamptz, nullable)

### 3.2 Experiment Configuration

```typescript
interface PricingExperimentConfig {
  enabled: boolean;
  trafficPercent: number; // e.g. 50 = 50% of traffic gets assigned
  variants: {
    A: { weight: number; tiers: TierOverride[] }; // control
    B: { weight: number; tiers: TierOverride[] }; // treatment
  };
  startedAt: string; // ISO date
  endedAt?: string;  // ISO date (null = ongoing)
}
```

Stored as a module-level config (env-var-driven or managed config feature flag), not in the DB — this keeps experiment lifecycle management simple.

### 3.3 Assignment Flow

1. Company visits pricing page → GET /api/companies/:id/billing/tiers
2. Server checks company.pricing_experiment_variant
3. If null:
   a. Hash company_id → variant (deterministic, 50/50 split)
   b. Write variant + enrolled_at to company row
4. Server returns variant-appropriate tier pricing
5. If variant B and Stripe price IDs differ, serve variant B's Stripe prices
6. Checkout session metadata includes `pricing_experiment_variant: "A"|"B"`

### 3.4 Tracking & Reporting

- **Stripe metadata**: Each checkout session carries `pricing_experiment_variant` 
- **Stripe subscription metadata**: Carries variant from checkout
- **Internal query**: `SELECT pricing_experiment_variant, COUNT(*) FROM companies` JOIN with subscription status
- **Dashboard**: Simple per-variant conversion stats endpoint

---

## 4. Implementation Phases

### Phase 1: Data Model & Migration (Founding Engineer)
- Add `pricing_experiment_variant` and `pricing_experiment_enrolled_at` columns to `companies` table
- Create migration SQL script
- Update Drizzle schema

### Phase 2: Experiment Service & Assignment (Founding Engineer)
- Create `pricingExperimentService` with:
  - Config parsing/validation
  - Deterministic variant assignment (hash company_id, modulo)
  - Read/write variant to company record
  - Variant-aware tier transformation
- Add `getTiersWithExperiment` to billing service

### Phase 3: API & Stripe Integration (Founding Engineer)
- Update GET /billing/tiers to pass experiment variant and return appropriate pricing
- Update POST /billing/create-checkout-session to include variant in metadata
- Add GET /billing/experiment/results endpoint for reporting

### Phase 4: UI Updates (Founding Engineer)
- Pricing page reads from server (already works — no changes needed unless variant B changes feature sets)
- Optional: Add experiment badge for authenticated users in variant B

### Phase 5: Review (Staff Engineer)
- Code review of all changes
- Verify assignment determinism, conversion tracking, edge cases

### Phase 6: Release (Release Engineer)
- Deploy migration + code to staging
- Verify experiment works in staging
- Deploy to production

### Phase 7: QA (QA Engineer)
- Verify variant assignment (A/B split)
- Verify Stripe metadata propagation
- Verify pricing display per variant

---

## 5. Edge Cases & Failure Modes

| Scenario | Handling |
|----------|----------|
| Company already assigned (e.g., pricing page revisited) | Read existing variant, no reassignment |
| Experiment not enabled | Normal pricing, no variant column needed |
| Variant B Stripe prices not configured | Fall back to variant A prices |
| Migration rollback | Remove columns, experiment stops. All existing assignments lost. |
| 5050 vs other split | Configurable via `trafficPercent` |
| New company created after experiment ends | No variant assigned, normal pricing |
| Stripe checkout without variant metadata | Log warning, treat as variant A for reporting |

---

## 6. Test Coverage

| Test | Coverage |
|------|----------|
| Unit: deterministic assignment (same company_id → same variant) | ✅ |
| Unit: 50/50 distribution over N companies (statistical) | ✅ |
| Unit: tier override application for variant B | ✅ |
| Unit: experiment disabled → normal tiers | ✅ |
| Unit: config validation (bad JSON, missing fields) | ✅ |
| Integration: GET /tiers returns variant-specific prices | ✅ |
| Integration: checkout session metadata includes variant | ✅ |
| E2E: Full checkout flow with variant tracking | ✅ |