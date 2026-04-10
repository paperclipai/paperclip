# Goals (목표)

## 목적
> 회사 전체부터 개별 작업까지 계층적 목표를 설정하고, 이슈/프로젝트를 목표에 연결하여 조직의 방향성을 추적한다.

## 목표
- 회사 → 팀 → 에이전트 → 작업 4단계 계층 목표 구조 지원
- 이슈/프로젝트를 목표에 자동 연결하여 진행 상황 간접 추적
- 목표가 없는 이슈에 회사 기본 목표를 자동 할당 (fallback 로직)

## 동작 구조

### 데이터 모델
```
goals
├── id (UUID, PK)
├── companyId (UUID, FK → companies)
├── title (text, 필수)
├── description (text, nullable)
├── level (enum: company | team | agent | task, 기본값 task)
├── status (enum: planned | active | achieved | cancelled, 기본값 planned)
├── parentId (UUID, FK → goals.id, 자기참조 — 트리 계층 구조)
├── ownerAgentId (UUID, FK → agents, nullable)
└── createdAt, updatedAt (timestamptz)

project_goals (N:N 연결 테이블)
├── projectId (UUID, FK → projects)
├── goalId (UUID, FK → goals)
├── companyId (UUID, FK → companies)
└── createdAt, updatedAt
```

### API
| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/companies/:companyId/goals` | 회사의 전체 목표 목록 |
| GET | `/goals/:id` | 단일 목표 조회 |
| POST | `/companies/:companyId/goals` | 목표 생성 |
| PATCH | `/goals/:id` | 목표 수정 |
| DELETE | `/goals/:id` | 목표 삭제 |

### 비즈니스 로직
- **계층 구조**: `parentId` 자기참조로 무한 depth 트리 가능. UI에서 `depth * 16 + 12` px 들여쓰기
- **기본 목표 해결**: `getDefaultCompanyGoal()` — active 상태의 루트 company-level 목표 우선, 없으면 아무 루트 → 아무 company-level 순서 fallback
- **이슈 Goal Fallback**: `resolveIssueGoalId()` — 이슈에 명시적 goalId 없으면 프로젝트의 goalId → 회사 기본 목표 순서로 자동 할당
- **활동 로그**: 생성/수정 시 activity 기록
- **텔레메트리**: 생성 시 goalLevel 기록
- **진행도 자동 계산 없음** — 연결된 이슈 상태로 간접 추적 (OKR Key Results 미구현)

### UI
- **GoalTree** (`ui/src/components/GoalTree.tsx`): `parentId` 기반 재귀 트리 렌더링, 접기/펼치기
- **Goals 페이지** (`ui/src/pages/Goals.tsx`): 목표 목록 + 새 목표 생성
- **GoalDetail** (`ui/src/pages/GoalDetail.tsx`): 개별 목표 상세 + 속성 패널

## 관련 엔티티
- **Issue**: `issues.goalId` FK — 이슈가 어떤 목표에 기여하는지
- **Project**: `projects.goalId` FK (1:1) + `project_goals` 테이블 (N:N)
- **Agent**: `goals.ownerAgentId` FK — 목표 소유 에이전트
- **Company**: `goals.companyId` FK — 소속 회사

## 파일 경로
| 구분 | 경로 |
|------|------|
| Schema | `packages/db/src/schema/goals.ts` |
| Schema (N:N) | `packages/db/src/schema/project_goals.ts` |
| Service | `server/src/services/goals.ts` |
| Fallback | `server/src/services/issue-goal-fallback.ts` |
| Route | `server/src/routes/goals.ts` |
| Validator | `packages/shared/src/validators/goal.ts` |
| Page | `ui/src/pages/Goals.tsx`, `ui/src/pages/GoalDetail.tsx` |
| Component | `ui/src/components/GoalTree.tsx` |
