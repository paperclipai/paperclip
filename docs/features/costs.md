# Costs & Budgets (비용 및 예산)

## 목적
> LLM API 사용 비용을 추적하고, 회사/에이전트 단위 예산 정책으로 지출을 제어하며, 초과 시 자동 인시던트를 생성한다.

## 목표
- 비용 이벤트 단위 기록 (프로바이더, 모델, 토큰, 비용)
- 회사/에이전트 단위 예산 정책 (월간/평생 윈도우)
- 경고 임계값(80%) + 하드스톱(100%) 자동 적용
- 인시던트 생성 → 수동 해결 워크플로우
- 다차원 비용 분석 (에이전트별/모델별/프로바이더별/프로젝트별)

## 동작 구조

### 데이터 모델
```
cost_events
├── id, companyId (FK → companies)
├── agentId (FK → agents), issueId, projectId, goalId, heartbeatRunId
├── provider (anthropic 등), biller, billingType (metered_api | subscription_*)
├── model (text)
├── inputTokens, cachedInputTokens, outputTokens
├── costCents (integer)
├── occurredAt, createdAt

budget_policies
├── id, companyId (FK)
├── scopeType (company | agent), scopeId
├── metric (billed_cents), windowKind (calendar_month_utc | lifetime)
├── amount (cents), warnPercent (기본 80)
├── hardStopEnabled, notifyEnabled, isActive
└── createdByUserId, updatedByUserId, createdAt, updatedAt

budget_incidents
├── id, companyId, policyId (FK → budget_policies)
├── scopeType, scopeId, metric, windowKind
├── windowStart, windowEnd
├── thresholdType, amountLimit, amountObserved
├── status (open | resolved)
├── approvalId (FK → approvals)
└── resolvedAt, createdAt, updatedAt
```

### API
| Method | Endpoint | 설명 |
|--------|----------|------|
| POST | `/companies/:companyId/cost-events` | LLM 비용 기록 |
| POST | `/companies/:companyId/finance-events` | 매출/결제 기록 |
| GET | `/companies/:companyId/costs/summary` | 비용 요약 (날짜 범위) |
| GET | `/companies/:companyId/costs/by-agent` | 에이전트별 비용 |
| GET | `/companies/:companyId/costs/by-agent-model` | 에이전트-모델별 비용 |
| GET | `/companies/:companyId/costs/by-provider` | 프로바이더별 비용 |
| GET | `/companies/:companyId/costs/by-project` | 프로젝트별 비용 |
| GET | `/companies/:companyId/costs/window-spend` | 현재 월 지출 |
| GET | `/companies/:companyId/budgets/overview` | 예산 현황 |
| POST | `/companies/:companyId/budgets/policies` | 예산 정책 생성/수정 |
| POST | `/:companyId/budget-incidents/:id/resolve` | 인시던트 해결 |
| PATCH | `/companies/:companyId/budgets` | 회사 월간 예산 설정 |
| PATCH | `/agents/:agentId/budgets` | 에이전트 월간 예산 설정 |

### 비즈니스 로직
- **자동 예산 체크**: 비용 이벤트 기록 시 정책과 비교, 임계값 초과 시 인시던트 자동 생성
- **예산 윈도우**: `calendar_month_utc`(매월 리셋) 또는 `lifetime`(누적)
- **경고/하드스톱**: `warnPercent`(기본 80%)에서 경고, 100%에서 하드스톱(작업 중단)
- **인시던트**: 초과 시 open 상태로 생성, 수동 resolve 필요 (승인과 연결 가능)
- **비용 귀속**: agentId, issueId, projectId, goalId로 다차원 귀속
- **Finance 이벤트**: LLM 비용과 별도로 매출/결제/환불 추적

### UI
- **Costs 페이지**: 비용 요약 + 다차원 분석 차트
- **Dashboard**: 월간 지출 카드 + 예산 인시던트 배너

## 관련 엔티티
- **Agent**: `cost_events.agentId` + `budget_policies`(agent 스코프)
- **Company**: 회사 월간 예산
- **Issue/Project/Goal**: 비용 귀속
- **Approval**: 인시던트 해결 시 승인 연결

## 파일 경로
| 구분 | 경로 |
|------|------|
| Schema | `packages/db/src/schema/cost_events.ts`, `budget_policies.ts`, `budget_incidents.ts` |
| Service | `server/src/services/costs.ts`, `budgets.ts` |
| Route | `server/src/routes/costs.ts` |
| Page | `ui/src/pages/Costs.tsx` |
