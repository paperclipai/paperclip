# M2.1: 거버넌스 시스템

**Phase:** M2.1
**Status:** Planning
**Created:** 2026-04-23

## 목표

Paperclip 기반 승인 게이트 + 감사 로그 + Tool-call 추적을 완전 구현한다.

- 기존 Paperclip 테이블 활용 (`approvals`, `activity_log`, `approval_comments`)
- 승인 요청 생성/조회/승인/거절 기능
- 감사 로그 조회 및 필터링
- UI 패널 완전 구현

---

## Wave 1: Shared Types + Service (병렬 가능)

### PLAN-01: Shared Types - Governance

**Objective:** 거버넌스 관련 타입 정의

**Files Modified:**
- `packages/shared/src/types/rt2-governance.ts` (신규)

**Tasks:**

```yaml
- id: shared-governance-types
  objective: Define governance types
  depends_on: []
  files_modified:
    - packages/shared/src/types/rt2-governance.ts
  read_first:
    - packages/shared/src/types/rt2-task.ts
    - packages/db/src/schema/approvals.ts
  action: |
    Create packages/shared/src/types/rt2-governance.ts:
    - ApprovalType: "hire_agent" | "approve_strategy" | "task_completion" | "deployment" | "budget_exceed"
    - ApprovalStatus: "pending" | "approved" | "rejected"
    - Rt2Approval: { id, companyId, type, requestedByAgentId, requestedByUserId, status, payload, decisionNote, decidedByUserId, decidedAt, createdAt, updatedAt }
    - Rt2ApprovalComment: { id, companyId, approvalId, authorAgentId, authorUserId, body, createdAt, updatedAt }
    - Rt2GovernanceStatus: { pendingApprovals, approvedThisWeek, rejectedThisWeek, averageApprovalTimeHours }
    - Rt2ActivityLogEntry: { id, companyId, actorType, actorId, action, entityType, entityId, agentId, runId, details, createdAt }
    - CreateApprovalRequest: { type: ApprovalType, payload: Record<string, unknown> }
    - DecisionRequest: { decisionNote?: string }
    - ActivityLogFilter: { entityType?, action?, actorType?, fromDate?, toDate?, limit? }
  acceptance_criteria:
    - "grep 'ApprovalType' packages/shared/src/types/rt2-governance.ts returns type"
    - "grep 'Rt2Approval' packages/shared/src/types/rt2-governance.ts returns interface"

- id: shared-export
  objective: Export governance types
  depends_on: [shared-governance-types]
  files_modified:
    - packages/shared/src/index.ts
  read_first:
    - packages/shared/src/index.ts
  action: |
    Add to packages/shared/src/index.ts:
    - export * from './types/rt2-governance'
  acceptance_criteria:
    - "grep 'rt2-governance' packages/shared/src/index.ts returns export"
```

---

### PLAN-02: Server Service - Full Governance

**Objective:** 승인 요청 CRUD + 감사 로그 서비스 완전 구현

**Files Modified:**
- `server/src/services/rt2-governance.ts` (수정)

**Tasks:**

```yaml
- id: svc-governance-full
  objective: Implement full governance service
  depends_on: []
  files_modified:
    - server/src/services/rt2-governance.ts
  read_first:
    - server/src/services/rt2-task-mesh.ts
    - packages/db/src/schema/approvals.ts
    - packages/db/src/schema/activity_log.ts
    - packages/db/src/schema/approval_comments.ts
  action: |
    Rewrite server/src/services/rt2-governance.ts:
    - Import approvals, activity_log, approval_comments tables
    - getGovernanceStatus(companyId): Query pending/approved/rejected counts + avg time
    - getApprovalQueue(companyId, filters?): Query approvals with optional type/status filter
    - getApprovalById(companyId, approvalId): Single approval with comments
    - createApproval(companyId, userId/agentId, type, payload): Insert new approval
    - approve(companyId, approvalId, userId, decisionNote?): Update status to 'approved'
    - reject(companyId, approvalId, userId, decisionNote?): Update status to 'rejected'
    - addComment(companyId, approvalId, authorId, authorType, body): Add comment
    - getActivityLog(companyId, filters): Query activity_log with filters
    - Tool-call entries use entityType='tool_call', action=tool_name
  acceptance_criteria:
    - "grep 'getApprovalQueue' server/src/services/rt2-governance.ts returns function"
    - "grep 'approve\\|reject' server/src/services/rt2-governance.ts returns both functions"
    - "grep 'getActivityLog' server/src/services/rt2-governance.ts returns function"
    - "grep 'addComment' server/src/services/rt2-governance.ts returns function"
```

---

## Wave 2: Routes + API Client (병렬 가능)

### PLAN-03: Server Routes - Full Governance API

**Objective:** 승인/거절/코멘트 API 추가

**Files Modified:**
- `server/src/routes/rt2-governance.ts` (수정)
- `server/src/app.ts` (확인)

**Tasks:**

```yaml
- id: route-governance-full
  objective: Add approval actions to routes
  depends_on: [svc-governance-full]
  files_modified:
    - server/src/routes/rt2-governance.ts
  read_first:
    - server/src/routes/rt2-governance.ts
    - server/src/app.ts
  action: |
    Update server/src/routes/rt2-governance.ts:
    - POST /companies/:companyId/rt2/governance/approvals - Create approval
    - GET /companies/:companyId/rt2/governance/approvals/:id - Get approval with comments
    - POST /companies/:companyId/rt2/governance/approvals/:id/approve - Approve
    - POST /companies/:companyId/rt2/governance/approvals/:id/reject - Reject
    - POST /companies/:companyId/rt2/governance/approvals/:id/comments - Add comment
    - GET /companies/:companyId/rt2/governance/activity-log - Get activity log
    Apply company scoping and auth middleware to all routes.
  acceptance_criteria:
    - "grep 'POST.*approvals' server/src/routes/rt2-governance.ts returns 3 routes"
    - "grep 'activity-log' server/src/routes/rt2-governance.ts returns route"
```

---

### PLAN-04: UI API Client - Full Governance

**Objective:** 승인 actions API 추가

**Files Modified:**
- `ui/src/api/rt2-governance.ts` (수정)

**Tasks:**

```yaml
- id: api-client-full
  objective: Add approval actions to client
  depends_on: [shared-governance-types, route-governance-full]
  files_modified:
    - ui/src/api/rt2-governance.ts
  read_first:
    - ui/src/api/rt2-governance.ts
  action: |
    Update ui/src/api/rt2-governance.ts:
    - createApproval(companyId, data: CreateApprovalRequest): POST /approvals
    - getApproval(companyId, approvalId): GET /approvals/:id
    - approveApproval(companyId, approvalId, decisionNote?): POST /approvals/:id/approve
    - rejectApproval(companyId, approvalId, decisionNote?): POST /approvals/:id/reject
    - addComment(companyId, approvalId, body): POST /approvals/:id/comments
    - getActivityLog(companyId, filters?): GET /activity-log
  acceptance_criteria:
    - "grep 'createApproval' ui/src/api/rt2-governance.ts returns function"
    - "grep 'approveApproval' ui/src/api/rt2-governance.ts returns function"
    - "grep 'getActivityLog' ui/src/api/rt2-governance.ts returns function"
```

---

## Wave 3: UI Panel Enhancement

### PLAN-05: UI Panel - Full Governance

**Objective:** 승인/거절/코멘트 UI 완전 구현

**Files Modified:**
- `ui/src/components/Rt2GovernancePanel.tsx` (수정)

**Tasks:**

```yaml
- id: ui-governance-full
  objective: Implement full governance UI
  depends_on: [api-client-full]
  files_modified:
    - ui/src/components/Rt2GovernancePanel.tsx
  read_first:
    - ui/src/components/Rt2GovernancePanel.tsx
    - ui/src/components/Rt2GovernancePanel.tsx (current stub)
  action: |
    Rewrite ui/src/components/Rt2GovernancePanel.tsx:
    - Stats cards: pendingApprovals, approvedThisWeek, rejectedThisWeek, avgTime
    - Approval queue list with:
      - Type badge, task title, requested by, timestamp
      - Approve button (green) - calls approveApproval
      - Reject button (red) - calls rejectApproval
      - Comment section with add comment form
    - Activity log tab/section:
      - Filterable by entityType, action, actorType, date range
      - Entries show: timestamp, actor, action, entityType:entityId, details summary
      - Tool-call entries highlighted
    - Use real API data, remove STUB_* constants
  acceptance_criteria:
    - "grep 'approveApproval' ui/src/components/Rt2GovernancePanel.tsx returns onClick handler"
    - "grep 'rejectApproval' ui/src/components/Rt2GovernancePanel.tsx returns onClick handler"
    - "grep 'getActivityLog' ui/src/components/Rt2GovernancePanel.tsx returns query"
    - "grep 'STUB_' ui/src/components/Rt2GovernancePanel.tsx returns nothing (removed)"
```

---

## Wave 4: Build + Verification

### PLAN-06: Build + Typecheck

**Objective:** 전체 빌드 및 타입체크 검증

**Tasks:**

```yaml
- id: typecheck
  objective: Run typecheck on all packages
  depends_on: [ui-governance-full]
  command: pnpm -r typecheck
  acceptance_criteria:
    - "typecheck exits 0 with no errors"

- id: build-ui
  objective: Build UI
  depends_on: [typecheck]
  command: cd ui && node node_modules/vite/bin/vite.js build
  acceptance_criteria:
    - "vite build exits 0"
```

---

## 의존성

```
Wave 1 (병렬):
  PLAN-01: Shared Types
  PLAN-02: Service
        ↓
Wave 2 (병렬):
  PLAN-03: Routes
  PLAN-04: API Client
        ↓
Wave 3:
  PLAN-05: UI Panel
        ↓
Wave 4:
  PLAN-06: Build
```

---

## 기존 인프라도 활용

Paperclip이 이미 제공하는 테이블:
- `approvals` - 승인 요청 저장
- `approval_comments` - 승인 코멘트
- `activity_log` - 감사 로그 (불변)
- `issue_approvals` - 이슈-승인 링크

rt2GovernanceService는 이 테이블들을 사용하도록 완전 구현한다.
