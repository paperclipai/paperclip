# Routines (루틴)

## 목적
> 반복 작업(데일리 스탠드업, 주간 회고, 정리 작업 등)을 cron 스케줄/웹훅/API로 트리거하고, 매 실행 시 이슈를 자동 생성한다.

## 목표
- cron 표현식 기반 스케줄 트리거 + 웹훅/API 트리거
- 동시 실행 정책: skip / coalesce / always_enqueue
- 변수 보간으로 실행 시점 데이터 주입
- 팀/프로젝트/목표 스코프 연결

## 동작 구조

### 데이터 모델
```
routines
├── id, companyId (FK → companies)
├── projectId (FK), teamId (FK), goalId (FK), parentIssueId (FK)
├── title, description
├── assigneeAgentId (FK → agents)
├── priority, status (active | paused | archived)
├── concurrencyPolicy (coalesce_if_active | skip_if_active | always_enqueue)
├── catchUpPolicy (skip_missed | ...)
├── variables (jsonb)
├── lastTriggeredAt, lastEnqueuedAt
└── createdAt, updatedAt

routine_triggers
├── id, routineId (FK), companyId
├── kind (schedule | webhook | api)
├── cronExpression, timezone, nextRunAt
├── publicId (웹훅 URL), secretId, label, enabled
└── createdAt, updatedAt

routine_runs
├── id, routineId (FK), triggerId (FK)
├── source (schedule | manual | api | webhook)
├── status (received | running | executed | skipped | coalesced | failed)
├── payload (jsonb), variables (jsonb), idempotencyKey
├── linkedIssueId (FK), coalescedIntoRunId (FK)
├── failureReason, completedAt
└── createdAt
```

### API
| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/companies/:companyId/routines` | 루틴 목록 |
| POST | `/companies/:companyId/routines` | 루틴 생성 |
| GET/PATCH | `/routines/:id` | 조회/수정 |
| GET | `/routines/:id/runs` | 실행 이력 |
| POST | `/routines/:id/run` | 수동 실행 |
| POST | `/routines/:id/triggers` | 트리거 추가 |
| PATCH/DELETE | `/routine-triggers/:id` | 트리거 수정/삭제 |
| POST | `/routine-triggers/:id/rotate-secret` | 웹훅 시크릿 로테이션 |
| POST | `/routine-triggers/public/:publicId/fire` | 웹훅 엔드포인트 (HMAC 서명) |

### 비즈니스 로직
- **스케줄러**: 30초 간격 tick, `nextRunAt ≤ now`인 트리거 찾아 실행 디스패치
- **동시 실행 정책**: `skip_if_active`(중복 실행 무시), `coalesce_if_active`(기존에 병합), `always_enqueue`(모두 큐잉)
- **변수 보간**: description 내 `@{variable}`을 실행 시점에 해석
- **웹훅**: publicId 기반 URL + HMAC 서명 검증, 시크릿 로테이션 지원
- **멱등성**: `idempotencyKey`로 웹훅 재시도 시 중복 실행 방지
- **팀 스코프**: 팀 삭제/아카이브 시 팀 루틴 자동 일시정지

### UI
- **Routines 페이지**: 루틴 목록
- **RoutineDetail**: 상세 + 트리거 관리 + 실행 이력
- **TeamRoutinesPage**: 팀 스코프 루틴 관리

## 관련 엔티티
- **Agent**: `assigneeAgentId` — 루틴 실행 담당 에이전트
- **Issue**: `linkedIssueId` — 실행 시 생성되는 이슈
- **Team**: `teamId` — 팀 스코프
- **Project**: `projectId` — 프로젝트 스코프
- **Goal**: `goalId` — 목표 연결

## 파일 경로
| 구분 | 경로 |
|------|------|
| Schema | `packages/db/src/schema/routines.ts`, `routine_triggers.ts`, `routine_runs.ts` |
| Service | `server/src/services/routines.ts` |
| Route | `server/src/routes/routines.ts` |
| Page | `ui/src/pages/Routines.tsx`, `RoutineDetail.tsx` |
