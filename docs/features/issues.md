# Issues (이슈)

## 목적
> 에이전트에게 할당되는 작업 단위. 생성 → 할당 → 체크아웃 → 실행 → 완료 라이프사이클을 관리하며, 팀별 워크플로우와 목표에 연결된다.

## 목표
- 팀별 커스텀 워크플로우 상태 지원 (팀 식별자 기반 이슈 번호 생성)
- 에이전트 체크아웃/릴리스 기반 실행 잠금
- 목표 자동 할당 (Goal Fallback)
- 차단/차단됨 관계로 의존성 추적
- 코멘트, 문서, 작업 산출물, 승인 연결

## 동작 구조

### 데이터 모델
```
issues
├── id, companyId (FK → companies)
├── teamId (FK → teams), projectId (FK → projects), goalId (FK → goals)
├── parentId (FK → issues, 자기참조 — 서브이슈)
├── title, description
├── status (text, 기본값 backlog — 팀 워크플로우 slug 참조)
├── priority (critical | high | medium | low)
├── identifier (text, unique — e.g. ENG-42), issueNumber
├── assigneeAgentId (FK → agents), assigneeUserId
├── checkoutRunId, executionRunId (FK → heartbeatRuns)
├── executionLockedAt, executionState (jsonb)
├── originKind (manual | routine_execution | ...), originId
├── billingCode, estimate
├── startedAt, completedAt, cancelledAt, hiddenAt
└── createdAt, updatedAt
```

### API
| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/companies/:companyId/issues` | 이슈 목록 (필터 지원) |
| POST | `/companies/:companyId/issues` | 이슈 생성 |
| GET/PATCH/DELETE | `/issues/:id` | 조회/수정/삭제 |
| POST | `/issues/:id/checkout` | 에이전트 실행 잠금 |
| POST | `/issues/:id/release` | 실행 잠금 해제 |
| GET/POST | `/issues/:id/comments` | 코멘트 목록/추가 |
| GET/POST/DELETE | `/issues/:id/approvals` | 승인 연결 관리 |
| GET/PUT/DELETE | `/issues/:id/documents/:key` | 문서 관리 |
| POST | `/issues/:id/work-products` | 작업 산출물 생성 |
| POST/DELETE | `/issues/:id/read` | 읽음 표시 |
| POST/DELETE | `/issues/:id/inbox-archive` | 인박스 보관 |

### 비즈니스 로직
- **식별자 생성**: teamId 있으면 `팀.identifier + 팀.issueCounter` (ENG-42), 없으면 `회사.issuePrefix + 회사.issueCounter`
- **상태 전환 검증**: `assertTransition(from, to)` — 유효한 전환만 허용, 팀 워크플로우 상태 존재 확인
- **체크아웃/릴리스**: 에이전트가 이슈를 잠그고 실행, `checkoutRunId + executionLockedAt`으로 추적
- **Goal Fallback**: `resolveIssueGoalId()` — 명시적 goalId > 프로젝트 goalId > 회사 기본 목표
- **차단 관계**: `issue_relations` 테이블로 blocks/blocked_by 양방향 추적, 순환 의존성 감지
- **웨이크업**: 이슈 할당 시 `shouldWakeAssigneeOnCheckout()`로 에이전트 자동 깨우기

### UI
- **IssuesList**: 테이블 + 칸반 뷰, 필터(상태/우선순위/담당자/프로젝트/팀/라벨), 그룹핑, 정렬
- **IssueDetail**: 탭 — Activity, Documents, Work Products, Timeline + 인라인 편집
- **NewIssueDialog**: 이슈 생성 폼

## 관련 엔티티
- **Agent**: 담당자(`assigneeAgentId`), 생성자(`createdByAgentId`)
- **Team**: `teamId` — 팀 스코프 워크플로우/식별자
- **Project**: `projectId` — 프로젝트 소속
- **Goal**: `goalId` — 목표 연결 (fallback 포함)
- **Approval**: `issue_approvals` N:N 연결
- **Room**: `room_issues`로 채팅방에 연결

## 파일 경로
| 구분 | 경로 |
|------|------|
| Schema | `packages/db/src/schema/issues.ts` |
| Service | `server/src/services/issues.ts` |
| Fallback | `server/src/services/issue-goal-fallback.ts` |
| Route | `server/src/routes/issues.ts` |
| Page | `ui/src/pages/IssueDetail.tsx` |
| Component | `ui/src/components/IssuesList.tsx`, `IssueRow.tsx`, `NewIssueDialog.tsx` |
