# M4.1 AI Auto Evaluation - Implementation Plan

## Phase 1: Schema Changes

### 1.1 Create rt2_base_prices.ts
- File: `packages/db/src/schema/rt2_base_prices.ts`
- Table: `rt2BasePrices`
- Fields:
  - id (UUID, PK)
  - companyId (UUID, FK)
  - deliverableType (TEXT, indexed)
  - basePrice (INTEGER, gold units)
  - autoApproveThreshold (REAL, default 0.1)
  - isActive (BOOLEAN, default true)
  - createdAt, updatedAt

### 1.2 Extend rt2QualityScores
- Add `basePrice` (INTEGER, nullable) - snapshot at evaluation time
- Add `autoApprovalBandLow` (INTEGER, nullable)
- Add `autoApprovalBandHigh` (INTEGER, nullable)
- Add `evaluationMode` (TEXT, 'auto' | 'copilot')
- Update index.ts exports

### 1.3 Generate Migration
```bash
pnpm db:generate
```

## Phase 2: Service Implementation

### 2.1 Create rt2-auto-evaluation.ts Service
- File: `server/src/services/rt2-auto-evaluation.ts`
- Functions:
  - `getBasePrice(companyId, deliverableType)` - Get or create default
  - `setBasePrice(companyId, deliverableType, price, threshold?)` - Create/update
  - `deleteBasePrice(companyId, deliverableType)`
  - `listBasePrices(companyId)`
  - `evaluateDeliverable(companyId, taskIssueId, aiScore, deliverableType)` - Core auto-eval logic
  - `getAutoEvaluationStats(companyId)` - Statistics
  - `getEvaluations(companyId, mode?)` - List by mode

## Phase 3: Route Implementation

### 3.1 Create rt2-auto-evaluation Routes
- File: `server/src/routes/rt2-auto-evaluation.ts`
- Routes:
  - `GET /rt2/base-prices` - List base prices
  - `POST /rt2/base-prices` - Create base price
  - `PUT /rt2/base-prices/:type` - Update base price
  - `DELETE /rt2/base-prices/:type` - Delete base price
  - `POST /rt2/auto-evaluate` - Create auto evaluation
  - `GET /rt2/auto-evaluations` - List evaluations
  - `GET /rt2/auto-evaluation/stats` - Statistics
  - `GET /rt2/auto-eval/threshold` - Get threshold
  - `PUT /rt2/auto-eval/threshold` - Update threshold

### 3.2 Register Routes in app.ts
- Import rt2AutoEvaluationRoutes
- Register with `/companies/:companyId/rt2/` prefix

## Phase 4: Verification

### 4.1 Typecheck
```bash
pnpm -r typecheck
```
Fix any errors.

### 4.2 Build
```bash
pnpm build
```

### 4.3 Update ROADMAP
- Mark M4.1 as complete with ✅

## Default Base Prices

Initial defaults (can be customized per company):
| Type | Base Price (Gold) |
|------|-------------------|
| code_review | 50 |
| bug_fix | 30 |
| feature_delivery | 100 |
| documentation | 40 |
| testing | 35 |
| research | 60 |
| design | 80 |
| deployment | 45 |
| meeting | 20 |
| default | 50 |

## File Checklist

- [x] `packages/db/src/schema/rt2_base_prices.ts` - NEW
- [ ] `packages/db/src/schema/rt2_quality_scores.ts` - MODIFY (add fields)
- [ ] `packages/db/src/schema/index.ts` - MODIFY (export new table)
- [ ] `server/src/services/rt2-auto-evaluation.ts` - NEW
- [ ] `server/src/routes/rt2-auto-evaluation.ts` - NEW
- [ ] `server/src/app.ts` - MODIFY (register routes)
- [ ] `drizzle.config.ts` or migration - GENERATE

## Dependencies

- rt2QualityScores (existing)
- rt2GamificationXpTransactions (for XP rewards)
- rt2GamificationAgentBalances (for gold rewards)

## Risks & Mitigations

1. **Migration complexity**: Keep changes additive (nullable fields)
2. **Default prices not set**: Fall back to Co-Pilot for unknown types
3. **Existing evaluations**: New fields are nullable, don't break existing data
