# Teams (팀)

## 목적
> 에이전트를 팀으로 조직화하고, 팀별 워크플로우 상태/이슈/프로젝트/문서를 관리한다. Linear 스타일의 팀 기반 작업 구조.

## 목표
- 에이전트를 팀 단위로 그룹화 (리드 + 멤버 역할)
- 팀별 커스텀 워크플로우 상태 정의 (backlog → done 등)
- 팀 스코프의 이슈/프로젝트/문서/루틴/승인 관리
- GitHub repo 연결로 PR 자동 라우팅

## 동작 구조

### 데이터 모델
```
teams
├── id (UUID, PK)
├── companyId (UUID, FK → companies)
├── name (text, 필수)
├── identifier (text, 2-5 대문자 — 이슈 식별자에 사용, e.g. ENG-42)
├── description (text, nullable)
├── color (text, hex color)
├── status (text: active | archived)
├── leadAgentId (UUID, FK → agents, nullable)
├── issueCounter (integer, 자동 증가)
├── settings (jsonb — githubRepoUrl 등)
└── createdAt, updatedAt

team_members
├── id (UUID, PK)
├── teamId (UUID, FK → teams)
├── companyId (UUID, FK → companies)
├── agentId (UUID, FK → agents, nullable)
├── userId (text, nullable)
├── role (text: lead | member)
└── createdAt, updatedAt

team_workflow_statuses
├── id (UUID, PK)
├── teamId (UUID, FK → teams)
├── companyId (UUID, FK → companies)
├── name (text, 표시명)
├── slug (text, immutable — rename-safe)
├── category (enum: backlog | unstarted | started | completed | canceled)
├── color (text, hex)
├── isDefault (boolean)
├── sortOrder (integer)
└── createdAt, updatedAt
```

### API
| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/companies/:companyId/teams` | 팀 목록 |
| GET | `/companies/:companyId/teams/:teamId` | 팀 상세 |
| POST | `/companies/:companyId/teams` | 팀 생성 |
| PATCH | `/companies/:companyId/teams/:teamId` | 팀 수정 |
| DELETE | `/companies/:companyId/teams/:teamId` | 팀 삭제 |
| GET | `/companies/:companyId/teams/:teamId/members` | 멤버 목록 |
| POST | `/companies/:companyId/teams/:teamId/members` | 멤버 추가 |
| DELETE | `/companies/:companyId/teams/:teamId/members/:memberId` | 멤버 제거 |
| GET | `/companies/:companyId/teams/:teamId/workflow-statuses` | 워크플로우 상태 목록 |
| POST | `/companies/:companyId/teams/:teamId/workflow-statuses` | 상태 추가 |
| PATCH | `/companies/:companyId/teams/:teamId/workflow-statuses/:id` | 상태 수정 |
| DELETE | `/companies/:companyId/teams/:teamId/workflow-statuses/:id` | 상태 삭제 |

### 비즈니스 로직
- **팀 생성 시 기본 워크플로우 상태 6개 자동 생성**: Backlog, Blocked, Todo(default), In Progress, Done, Canceled
- **워크플로우 상태에 immutable slug**: 이름 변경해도 slug 유지 → rename-safe
- **리드 변경**: `teams.leadAgentId` 업데이트 시 `team_members.role` 자동 동기화 (서비스 트랜잭션)
- **마지막 상태 삭제 방지**: 카테고리 내 마지막 상태는 삭제 불가 (409 에러)
- **slug 충돌 방지**: 같은 팀 내 동일 slug 409
- **GitHub repo 연결**: `teams.settings.githubRepoUrl` — webhook PR이 팀 이슈에 자동 연결

### UI
- **팀 사이드바**: 팀별 접기/펼치기, 이슈/프로젝트/Docs 하위 메뉴
- **TeamIssuesPage**: 팀 스코프 이슈 목록 (IssuesList 컴포넌트 재사용)
- **TeamProjectsPage**: 팀 연결 프로젝트
- **TeamSettingsPage**: 워크플로우 상태 편집, 멤버 관리, Git repo, 삭제
- **TeamRoutinesPage**: 팀 루틴 관리
- **TeamApprovalsPage**: 팀 승인 대기열
- **TeamDocsPage/TeamDocDetailPage**: 팀 문서 CRUD + 마크다운 에디터

## 관련 엔티티
- **Agent**: `team_members.agentId` — 팀 멤버, `teams.leadAgentId` — 팀 리드
- **Issue**: `issues.teamId` FK — 이슈가 속한 팀, `issues.status` text가 워크플로우 slug 참조
- **Project**: 프로젝트를 팀에 연결 가능
- **Routine**: 팀 스코프 루틴 (`routines.teamId`)
- **Approval**: 팀 이슈에 연결된 승인
- **Document**: `team_documents` 테이블 — 팀별 문서

## 파일 경로
| 구분 | 경로 |
|------|------|
| Schema | `packages/db/src/schema/teams.ts` |
| Schema | `packages/db/src/schema/team_members.ts` |
| Schema | `packages/db/src/schema/team_workflow_statuses.ts` |
| Service | `server/src/services/teams.ts` |
| Route | `server/src/routes/teams.ts` |
| Page | `ui/src/pages/Teams.tsx` (모든 팀 서브페이지 포함) |
