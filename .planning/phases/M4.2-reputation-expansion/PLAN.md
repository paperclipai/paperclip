# M4.2 명성 지수 확장 - Implementation Plan

## Phase 1: Schema Changes

### 1.1 Create rt2_reputation_expansion.ts
- File: `packages/db/src/schema/rt2_reputation_expansion.ts`
- Tables:
  - `rt2PromotionTriggers` - promotion eligibility tracking
  - `rt2PerformanceReviews` - formal performance review records
  - `rt2CreditConversionLedger` - credit-to-gold conversion log
- Default constants:
  - `CREDITS_PER_GOLD = 10`
  - `PROMOTION_THRESHOLDS = { senior: 700, expert: 850, legend: 950 }`
  - `GRADE_THRESHOLDS = { S: 100, A: 50, B: 0, C: -50, D: -Infinity }`

### 1.2 Update index.ts
- Export new tables

### 1.3 Generate Migration
```bash
pnpm db:generate
```

## Phase 2: Service Implementation

### 2.1 Create rt2-reputation-expansion.ts Service
- File: `server/src/services/rt2-reputation-expansion.ts`
- Functions:
  - `checkPromotionEligibility(companyId, agentId)` - Check if reputation qualifies for promotion
  - `createPromotionTrigger(companyId, agentId)` - Create pending promotion
  - `resolvePromotion(id, companyId, decision)` - Approve/reject/auto
  - `getPendingPromotions(companyId)` - List pending promotions
  - `createPerformanceReview(companyId, agentId, period, startDate, endDate)` - Create review
  - `calculateGrade(reputationDelta)` - Determine grade from delta
  - `submitPerformanceReview(id, companyId, reviewData)` - Submit review
  - `getCreditBalance(companyId, actorId, actorType)` - Get current credits
  - `convertCreditsToGold(companyId, actorId, actorType, credits)` - Convert credits
  - `getConversionHistory(companyId, actorId?)` - Get conversion ledger

## Phase 3: Route Implementation

### 3.1 Create rt2-reputation-expansion Routes
- File: `server/src/routes/rt2-reputation-expansion.ts`
- Routes:
  - `GET /rt2/promotion-triggers`
  - `POST /rt2/promotion-triggers/check/:agentId`
  - `PUT /rt2/promotion-triggers/:id/resolve`
  - `GET /rt2/performance-reviews`
  - `POST /rt2/performance-reviews`
  - `GET /rt2/performance-reviews/:id`
  - `PUT /rt2/performance-reviews/:id`
  - `GET /rt2/credit-balance/:actorId`
  - `POST /rt2/convert-credits`
  - `GET /rt2/credit-history`

### 3.2 Register Routes in app.ts

## Phase 4: Verification

### 4.1 Typecheck
```bash
pnpm -r typecheck
```

### 4.2 Update ROADMAP
- Mark M4.2 as complete with ✅

## File Checklist

- [x] `packages/db/src/schema/rt2_reputation_expansion.ts` - NEW
- [ ] `packages/db/src/schema/index.ts` - MODIFY (export new tables)
- [ ] `server/src/services/rt2-reputation-expansion.ts` - NEW
- [ ] `server/src/routes/rt2-reputation-expansion.ts` - NEW
- [ ] `server/src/app.ts` - MODIFY (register routes)
