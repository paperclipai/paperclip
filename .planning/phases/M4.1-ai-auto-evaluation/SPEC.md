# M4.1 AI Auto 평가 - Specification

## Problem Statement

M3.1 Co-Pilot 평가 시스템에서 모든 AI 평가는 매니저의 최종 승인이 필요합니다. 이는 품질은 보장하지만, 기준가(기대 산출물 가치) 대비显著하게 이탈하지 않는 평가에 대해서도 관리자의 수동 개입이 필요하여 비효율적입니다.

## Solution: Auto Evaluation within ±10% Band

M4.1은 산출물 유형별 기준가(Baseline Price)를 설정하고, AI 평가 점수가 기준가 대비 ±10% 이내이면 자동으로 승인处理, 해당 범위를 초과하는 평가만 Co-Pilot 모드(매니저 승인)로 전환합니다.

## Core Concepts

### 기준가 (Base Price)
- 산출물 유형별 기대 가치 (Gold 단위)
- 예: `code_review` = 50g, `bug_fix` = 30g, `feature_delivery` = 100g
- 회사/프로젝트별로 커스터마이징 가능

### 자동 승인 구간 (Auto-Approval Band)
- 기준가의 90% ~ 110% 범위
- 이 범위 내 평가: 자동으로 `approved` 처리, 즉시 보상 적용
- 이 범위 밖 평가: Co-Pilot 모드로 전환, 매니저 승인 필요

### 판단 로직
```
AI Score = 85 (예: 품질 점수 85/100)
Base Price = 100g (산출물 유형 기준가)
Expected Score = Base Price * (AI Score / 100) = 85g

Tolerance = ±10% = 76.5g ~ 93.5g

If Expected Score within [76.5g, 93.5g]:
  → Auto-Approve
Else:
  → Escalate to Co-Pilot
```

## Data Model Changes

### rt2BasePrices (New Table)
```
- companyId: UUID (FK)
- deliverableType: TEXT (e.g., 'code_review', 'bug_fix', 'feature')
- basePrice: INTEGER (gold units)
- autoApproveThreshold: REAL (default 0.1 = ±10%)
- isActive: BOOLEAN
```

### rt2QualityScores (Extend)
```
- basePrice: INTEGER (snapshot of base price at evaluation time)
- autoApprovalBandLow: INTEGER (basePrice * 0.9)
- autoApprovalBandHigh: INTEGER (basePrice * 1.1)
- evaluationMode: TEXT ('auto', 'copilot') -- NEW
```

## API Endpoints

### Base Price Management
- `GET /companies/:companyId/rt2/base-prices` - List all base prices
- `POST /companies/:companyId/rt2/base-prices` - Create base price
- `PUT /companies/:companyId/rt2/base-prices/:type` - Update base price
- `DELETE /companies/:companyId/rt2/base-prices/:type` - Delete base price

### Auto Evaluation
- `POST /companies/:companyId/rt2/auto-evaluate` - Create auto evaluation
- `GET /companies/:companyId/rt2/auto-evaluations` - List auto evaluations
- `GET /companies/:companyId/rt2/auto-evaluation/stats` - Auto evaluation statistics

### Threshold Configuration
- `GET /companies/:companyId/rt2/auto-eval/threshold` - Get threshold
- `PUT /companies/:companyId/rt2/auto-eval/threshold` - Update threshold

## Evaluation Flow

1. **Evaluation Request** → AI produces quality score (0-100)
2. **Lookup Base Price** → Get base price for deliverable type
3. **Calculate Expected Score** → `basePrice * (aiScore / 100)`
4. **Determine Mode**:
   - If within ±10%: Set `evaluationMode = 'auto'`, auto-approve
   - If outside ±10%: Set `evaluationMode = 'copilot'`, pending manager review
5. **Execute**: Auto-approve or escalate

## Edge Cases

- **No Base Price**: Fall back to Co-Pilot mode (all pending)
- **Score = 0**: Always Co-Pilot (anomalous)
- **Negative Score**: Always Co-Pilot
- **Threshold = 0**: All Co-Pilot
- **Threshold = 1.0**: All Auto

## Success Criteria

1. Base price CRUD operations work correctly
2. Auto-evaluation logic correctly determines auto vs copilot mode
3. Within ±10% band → auto-approved (isFinalized=1, managerDecision='approved')
4. Outside ±10% band → copilot pending (isFinalized=0, managerDecision='pending')
5. Statistics endpoint returns accurate counts
6. typecheck passes
7. Integration with existing rt2QualityScores table
