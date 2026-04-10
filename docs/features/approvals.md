# Approvals (승인)

## 목적
> 에이전트의 중요한 액션(채용, 배포, 예산 초과 등)에 보드/사람의 승인을 요구하는 워크플로우를 제공한다.

## 목표
- 다단계 상태 머신: pending → approved/rejected 또는 revision_requested → 재제출
- 이슈에 N:M으로 연결하여 감사 추적
- 코멘트 기반 의사결정 기록
- 민감 페이로드(채용 시 비밀키) 자동 삭제

## 동작 구조

### 데이터 모델
```
approvals
├── id, companyId (FK → companies)
├── type (text — hire_agent 등)
├── requestedByAgentId (FK → agents), requestedByUserId
├── status (pending | revision_requested | approved | rejected)
├── payload (jsonb — 타입별 상세 데이터)
├── decisionNote, decidedByUserId, decidedAt
└── createdAt, updatedAt

issue_approvals (N:M)
├── issueId (FK → issues), approvalId (FK → approvals)
├── companyId, linkedByAgentId, linkedByUserId
└── createdAt

approval_comments — 승인별 코멘트 감사 기록
```

### API
| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/companies/:companyId/approvals` | 승인 목록 (상태/팀 필터) |
| GET | `/approvals/:id` | 승인 상세 |
| POST | `/companies/:companyId/approvals` | 승인 요청 생성 |
| POST | `/approvals/:id/approve` | 승인 |
| POST | `/approvals/:id/reject` | 반려 |
| POST | `/approvals/:id/request-revision` | 수정 요청 |
| POST | `/approvals/:id/resubmit` | 재제출 |
| GET/POST | `/approvals/:id/comments` | 코멘트 관리 |

### 비즈니스 로직
- **상태 머신**: pending → approved/rejected, 또는 pending → revision_requested → pending → approved/rejected
- **페이로드 삭제**: hire_agent 타입은 민감 정보(비밀키) 응답 시 자동 삭제
- **이슈 연결**: `issue_approvals`로 승인을 여러 이슈에 연결 (감사 추적)
- **Room 연동**: 룸 액션 메시지에 `approvalId` FK로 승인 게이팅

### UI
- **Approvals 페이지**: 전체 승인 목록, 상태별 필터(Pending/All)
- **ApprovalCard**: 승인/반려 버튼, 상태 배지
- **TeamApprovalsPage**: 팀 스코프 승인 대기열

## 관련 엔티티
- **Issue**: `issue_approvals` N:M 연결
- **Agent**: 요청자(`requestedByAgentId`)
- **Room**: 액션 메시지의 승인 게이팅(`room_messages.approvalId`)
- **Budget**: 예산 인시던트 해결 시 승인 연결

## 파일 경로
| 구분 | 경로 |
|------|------|
| Schema | `packages/db/src/schema/approvals.ts`, `issue_approvals.ts` |
| Service | `server/src/services/approvals.ts` |
| Route | `server/src/routes/approvals.ts` |
| Page | `ui/src/pages/Approvals.tsx` |
| Component | `ui/src/components/ApprovalCard.tsx` |
