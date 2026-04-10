# Projects (프로젝트)

## 목적
> 이슈를 프로젝트 단위로 묶어 관리하고, 워크스페이스(코드 저장소)를 연결하여 에이전트의 실행 환경을 구성한다.

## 목표
- 프로젝트별 이슈 그룹화 및 진행 상태 추적
- 워크스페이스(GitHub repo, 로컬 폴더, 관리형 체크아웃) 연결
- 목표와 N:M 관계로 다중 목표 기여 추적
- 리드 에이전트 지정 및 환경 설정

## 동작 구조

### 데이터 모델
```
projects
├── id, companyId (FK → companies)
├── name, description, color
├── status (text, 기본값 backlog)
├── goalId (FK → goals, nullable — 주 목표)
├── leadAgentId (FK → agents, nullable)
├── targetDate (date)
├── env (jsonb — 에이전트 환경 설정)
├── executionWorkspacePolicy (jsonb)
├── health, healthUpdatedAt
├── pauseReason, pausedAt
├── archivedAt (소프트 삭제)
└── createdAt, updatedAt

project_goals (N:M 연결)
├── projectId (FK → projects)
├── goalId (FK → goals)
└── companyId, createdAt, updatedAt
```

### API
| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/companies/:companyId/projects` | 프로젝트 목록 (`?teamId=` 필터) |
| POST | `/companies/:companyId/projects` | 프로젝트 생성 |
| GET/PATCH/DELETE | `/projects/:id` | 조회/수정/삭제 |
| POST | `/projects/:id/workspaces` | 워크스페이스 추가 |
| PATCH/DELETE | `/projects/:id/workspaces/:wid` | 워크스페이스 수정/삭제 |
| POST | `/projects/:id/workspaces/:wid/runtime-services/:action` | 런타임 서비스 시작/중지/재시작 |

### 비즈니스 로직
- **워크스페이스**: 프로젝트당 1개 primary + N개 non-primary, 소스 타입(repo/local_folder/managed_checkout)
- **목표 동기화**: `syncGoalLinks(projectId, goalIds)` — `project_goals` 테이블 N:M 관계 갱신
- **코드베이스 해석**: `deriveProjectCodebase()` — repo URL, 로컬 폴더, 관리형 폴더에서 effective 코드베이스 계산
- **아카이브**: `archivedAt` 타임스탬프로 소프트 삭제, UI에서 필터링
- **일시정지**: `pauseReason + pausedAt`으로 프로젝트 중단 상태 관리

### UI
- **Projects 페이지**: 프로젝트 목록 뷰
- **ProjectDetail**: 탭 — Overview, Issues, Configuration, Budget, Workspaces
- **ProjectWorkspaceDetail**: 워크스페이스 상세 + 런타임 서비스 제어

## 관련 엔티티
- **Goal**: 1:1(`goalId`) + N:M(`project_goals`) 이중 구조
- **Issue**: `issues.projectId` FK — 프로젝트 소속 이슈
- **Agent**: `leadAgentId` — 프로젝트 리드 에이전트
- **Team**: teamId 필터로 팀별 프로젝트 조회
- **Workspace**: 1:N 워크스페이스, 런타임 서비스 관리

## 파일 경로
| 구분 | 경로 |
|------|------|
| Schema | `packages/db/src/schema/projects.ts` |
| Service | `server/src/services/projects.ts` |
| Route | `server/src/routes/projects.ts` |
| Page | `ui/src/pages/Projects.tsx`, `ProjectDetail.tsx`, `ProjectWorkspaceDetail.tsx` |
