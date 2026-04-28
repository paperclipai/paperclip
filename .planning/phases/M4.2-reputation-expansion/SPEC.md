# M4.2 명성 지수 확장 - Specification

## Problem Statement

M2.6에서 구현된 명성 지수(Reputation Index)는 협력 보상에 사용되지만:
1. 승진/고과 결정에 공식적으로 연결되지 않음
2. 크레딧(credits)이 금화(gold)로 전환되는 공식 경로가 없음

## Solution

M4.2는 명성 지수를 커리어 발전과 공식 고과 시스템에 연결하고, 크레딧-금화 전환 메커니즘을 구현합니다.

## Core Concepts

### 승진 트리거 (Promotion Triggers)
명성 지수가 특정 임계값을 초과하면 승진考慮로 등록:
- **Senior** (700+): 기본 multipler 1.3 적용
- **Expert** (850+): multiplier 1.5 적용
- **Legend** (950+): 특별한 인정과 특권

### 고과 기록 (Performance Review Records)
공식 고과 데이터를 저장:
- 평가 기간 (분기/반기/연간)
- 시작/종료 시점의 명성 지수
- 등급 (S/A/B/C/D)
- 피드백 코멘트

### 크레딧-금화 전환 (Credit-to-Gold Conversion)
- collaborationEvents에서 누적된 pointsEarned를 gold로 전환
- 전환 비율: 10 credits = 1 gold (설정 가능)
- 전환 거래 로그 기록

## Data Model

### rt2PromotionTriggers (New)
```
- id: UUID (PK)
- companyId: UUID (FK)
- agentId: UUID (FK)
- reputationThreshold: INTEGER (이 임계값 초과 시 트리거)
- status: TEXT ('pending', 'approved', 'rejected', 'auto_promoted')
- triggeredAt: TIMESTAMP
- resolvedAt: TIMESTAMP
- resolvedBy: TEXT (manager ID or 'system')
- createdAt, updatedAt
```

### rt2PerformanceReviews (New)
```
- id: UUID (PK)
- companyId: UUID (FK)
- agentId: UUID (FK)
- reviewPeriod: TEXT ('quarterly', 'halfyearly', 'yearly')
- periodStart: DATE
- periodEnd: DATE
- reputationStart: INTEGER
- reputationEnd: INTEGER
- reputationDelta: INTEGER
- grade: TEXT ('S', 'A', 'B', 'C', 'D')
- feedback: TEXT
- reviewerId: TEXT
- status: TEXT ('draft', 'submitted', 'acknowledged')
- createdAt, updatedAt
```

### rt2CreditConversionLedger (New)
```
- id: UUID (PK)
- companyId: UUID (FK)
- actorId: TEXT
- actorType: TEXT ('user', 'agent')
- creditsConverted: INTEGER
- goldReceived: INTEGER
- conversionRate: REAL (e.g., 0.1 = 10 credits per gold)
- source: TEXT ('collaboration', 'achievement', 'manual')
- workProductId: UUID (optional reference)
- createdAt
```

## API Endpoints

### Promotion Management
- `GET /companies/:companyId/rt2/promotion-triggers` - List pending promotions
- `POST /companies/:companyId/rt2/promotion-triggers/check/:agentId` - Check if agent qualifies
- `PUT /companies/:companyId/rt2/promotion-triggers/:id/resolve` - Approve/reject promotion

### Performance Reviews
- `GET /companies/:companyId/rt2/performance-reviews` - List reviews
- `POST /companies/:companyId/rt2/performance-reviews` - Create draft review
- `GET /companies/:companyId/rt2/performance-reviews/:id` - Get review details
- `PUT /companies/:companyId/rt2/performance-reviews/:id` - Update/submit review

### Credit Conversion
- `GET /companies/:companyId/rt2/credit-balance/:agentId` - Get current credits
- `POST /companies/:companyId/rt2/convert-credits` - Convert credits to gold
- `GET /companies/:companyId/rt2/credit-history` - Conversion ledger

## Conversion Logic

```
1 credits_per_gold = 10 (default)

gold_received = floor(credits / credits_per_gold)
remaining_credits = credits % credits_per_gold
```

## Grade Calculation

Based on reputation delta over review period:
- S: delta >= +100
- A: delta >= +50
- B: delta >= 0
- C: delta >= -50
- D: delta < -50
