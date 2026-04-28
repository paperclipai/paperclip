# M1.6: 일일업무보고서 시스템

**Phase:** M1.6
**Status:** Planning
**Created:** 2026-04-23

## 목표

Paperclip 기반 Real-Tycoon 2에 **3패널 UI 레이아웃**의 일일업무보고서 시스템을 구현한다.

- Task(L5) + To-Do(L6) 중심 핵심 저장 단위
- 산출물 필수 정의 + 금화 기준가
- 기존 Rt2TaskPanel 기반 확장

---

## Wave 1: DB Schema + Server Service (병렬 가능)

### PLAN-01: DB Schema - Daily Reports

**Objective:** 일일업무보고서 관련 DB 테이블 생성

**Files Modified:**
- `packages/db/src/schema/rt2-daily-report.ts` (신규)
- `packages/db/src/schema/index.ts` (수정)

**Tasks:**

```yaml
- id: db-daily-reports
  objective: Create daily_reports table
  depends_on: []
  files_modified:
    - packages/db/src/schema/rt2-daily-report.ts
  read_first:
    - packages/db/src/schema/index.ts
    - packages/db/src/schema/rt2-task.ts
  action: |
    Create schema file packages/db/src/schema/rt2-daily-report.ts:
    - daily_reports table:
      - id: uuid PK
      - user_id: uuid FK -> users.id
      - report_date: date
      - mood_score: integer (1-5)
      - ai_summary: text
      - gold_earned: decimal
      - exp_earned: integer
      - status: enum ('draft', 'submitted', 'approved', 'returned')
      - created_at, updated_at timestamps
    - report_tasks table (join):
      - report_id: uuid FK -> daily_reports.id
      - task_id: uuid FK -> tasks.id
      - primary key (report_id, task_id)
    - report_todos table (join):
      - report_id: uuid FK -> daily_reports.id
      - todo_id: uuid FK -> todos.id
      - primary key (report_id, todo_id)
  acceptance_criteria:
    - "grep -r 'daily_reports' packages/db/src/schema/rt2-daily-report.ts returns table definition"
    - "grep -r 'report_tasks' packages/db/src/schema/rt2-daily-report.ts returns join table"
    - "grep -r 'report_todos' packages/db/src/schema/rt2-daily-report.ts returns join table"

- id: db-export-schema
  objective: Export schema from index
  depends_on: [db-daily-reports]
  files_modified:
    - packages/db/src/schema/index.ts
  read_first:
    - packages/db/src/schema/index.ts
  action: |
    Add to exports in packages/db/src/schema/index.ts:
    - export * from './rt2-daily-report'
  acceptance_criteria:
    - "grep 'rt2-daily-report' packages/db/src/schema/index.ts returns export"
```

---

### PLAN-02: Server Service - Daily Report Service

**Objective:** 일일업무보고서 CRUD 서비스 생성

**Files Modified:**
- `server/src/services/rt2-daily-report.ts` (신규)

**Tasks:**

```yaml
- id: svc-daily-report
  objective: Create rt2-daily-report service
  depends_on: [db-daily-reports]
  files_modified:
    - server/src/services/rt2-daily-report.ts
  read_first:
    - server/src/services/rt2-task-mesh.ts
    - server/src/services/index.ts
  action: |
    Create server/src/services/rt2-daily-report.ts:
    - DAILY_REPORT_STATUS enum: draft, submitted, approved, returned
    - Interface DailyReport with all fields from REQUIREMENTS.md
    - getReportsByUser(userId, dateRange) - fetch user's reports
    - getReportById(reportId) - fetch single report with tasks/todos
    - createReport(userId, date, tasks[], todos[]) - create new report
    - updateReport(reportId, data) - update existing report
    - submitReport(reportId) - change status to submitted
    - getTodayReport(userId) - convenience method for daily workflow
    - getReportStats(userId, dateRange) - gold earned, exp earned aggregation
    - generateAiSummary(reportId) - stub for AI summarization
  acceptance_criteria:
    - "grep -r 'getReportsByUser' server/src/services/rt2-daily-report.ts returns function"
    - "grep -r 'createReport' server/src/services/rt2-daily-report.ts returns function"
    - "grep -r 'submitReport' server/src/services/rt2-daily-report.ts returns function"
    - "grep -r 'getTodayReport' server/src/services/rt2-daily-report.ts returns function"

- id: svc-export
  objective: Export service
  depends_on: [svc-daily-report]
  files_modified:
    - server/src/services/index.ts
  read_first:
    - server/src/services/index.ts
  action: |
    Add export in server/src/services/index.ts:
    - export * from './rt2-daily-report'
  acceptance_criteria:
    - "grep 'rt2-daily-report' server/src/services/index.ts returns export"
```

---

### PLAN-03: Server Routes - Daily Report API

**Objective:** 일일업무보고서 REST API 라우트 생성

**Files Modified:**
- `server/src/routes/rt2-daily-report.ts` (신규)
- `server/src/app.ts` (수정)

**Tasks:**

```yaml
- id: route-daily-report
  objective: Create daily report routes
  depends_on: [svc-daily-report]
  files_modified:
    - server/src/routes/rt2-daily-report.ts
  read_first:
    - server/src/routes/rt2-task-mesh.ts
    - server/src/app.ts
  action: |
    Create server/src/routes/rt2-daily-report.ts:
    - GET /api/daily-reports - list user's reports
    - GET /api/daily-reports/today - get today's report
    - GET /api/daily-reports/:id - get single report
    - POST /api/daily-reports - create report
    - PUT /api/daily-reports/:id - update report
    - POST /api/daily-reports/:id/submit - submit report
    - GET /api/daily-reports/stats - get user's stats
    Apply company scoping and auth middleware to all routes.
  acceptance_criteria:
    - "grep -r 'GET.*daily-reports' server/src/routes/rt2-daily-report.ts returns routes"
    - "grep -r 'POST.*daily-reports' server/src/routes/rt2-daily-report.ts returns routes"
    - "grep -r 'PUT.*daily-reports' server/src/routes/rt2-daily-report.ts returns routes"

- id: route-register
  objective: Register routes in app
  depends_on: [route-daily-report]
  files_modified:
    - server/src/app.ts
  read_first:
    - server/src/app.ts
  action: |
    Import and register daily-report routes in server/src/app.ts:
    - import dailyReportRoutes from './routes/rt2-daily-report'
    - app.use('/api/daily-reports', dailyReportRoutes)
  acceptance_criteria:
    - "grep 'daily-report' server/src/app.ts returns import and use"
```

---

## Wave 2: Shared Types + UI API Client (병렬 가능)

### PLAN-04: Shared Types - Daily Report

**Objective:** 일일업무보고서 관련 타입 정의

**Files Modified:**
- `packages/shared/src/types/rt2-daily-report.ts` (신규)
- `packages/shared/src/index.ts` (수정)

**Tasks:**

```yaml
- id: shared-types
  objective: Define daily report types
  depends_on: []
  files_modified:
    - packages/shared/src/types/rt2-daily-report.ts
  read_first:
    - packages/shared/src/types/rt2-task.ts
    - packages/shared/src/index.ts
  action: |
    Create packages/shared/src/types/rt2-daily-report.ts:
    - DailyReportStatus: 'draft' | 'submitted' | 'approved' | 'returned'
    - DailyReport: { id, userId, reportDate, moodScore, aiSummary, goldEarned, expEarned, status, createdAt, updatedAt }
    - ReportTask: { reportId, taskId }
    - ReportTodo: { reportId, todoId }
    - CreateDailyReportRequest: { reportDate, taskIds, todoIds }
    - UpdateDailyReportRequest: { moodScore?, status? }
    - DailyReportStats: { totalGold, totalExp, reportCount, approvedCount }
    Export from packages/shared/src/index.ts.
  acceptance_criteria:
    - "grep -r 'DailyReportStatus' packages/shared/src/types/rt2-daily-report.ts returns type"
    - "grep -r 'DailyReport' packages/shared/src/types/rt2-daily-report.ts returns interface"

- id: shared-export
  objective: Export types from shared
  depends_on: [shared-types]
  files_modified:
    - packages/shared/src/index.ts
  read_first:
    - packages/shared/src/index.ts
  action: |
    Add to packages/shared/src/index.ts:
    - export * from './types/rt2-daily-report'
  acceptance_criteria:
    - "grep 'rt2-daily-report' packages/shared/src/index.ts returns export"
```

---

### PLAN-05: UI API Client

**Objective:** 일일업무보고서 API 클라이언트 생성

**Files Modified:**
- `ui/src/api/rt2-daily-report.ts` (신규)

**Tasks:**

```yaml
- id: api-client
  objective: Create daily report API client
  depends_on: [shared-types, route-daily-report]
  files_modified:
    - ui/src/api/rt2-daily-report.ts
  read_first:
    - ui/src/api/rt2-task.ts
  action: |
    Create ui/src/api/rt2-daily-report.ts:
    - getReports(params: { dateRange? }) - GET /api/daily-reports
    - getTodayReport() - GET /api/daily-reports/today
    - getReport(id: string) - GET /api/daily-reports/:id
    - createReport(data: CreateDailyReportRequest) - POST /api/daily-reports
    - updateReport(id: string, data: UpdateDailyReportRequest) - PUT /api/daily-reports/:id
    - submitReport(id: string) - POST /api/daily-reports/:id/submit
    - getStats(params: { dateRange? }) - GET /api/daily-reports/stats
    Use apiRequest helper from existing patterns.
  acceptance_criteria:
    - "grep -r 'getReports' ui/src/api/rt2-daily-report.ts returns function"
    - "grep -r 'createReport' ui/src/api/rt2-daily-report.ts returns function"
    - "grep -r 'submitReport' ui/src/api/rt2-daily-report.ts returns function"
```

---

## Wave 3: UI Panel Component

### PLAN-06: UI Panel - Daily Report

**Objective:** 일일업무보고서 패널 컴포넌트 생성

**Files Modified:**
- `ui/src/components/Rt2DailyReportPanel.tsx` (신규)
- `ui/src/pages/ProjectDetail.tsx` (수정)

**Tasks:**

```yaml
- id: ui-panel
  objective: Create Rt2DailyReportPanel component
  depends_on: [api-client, shared-types]
  files_modified:
    - ui/src/components/Rt2DailyReportPanel.tsx
  read_first:
    - ui/src/components/Rt2TaskPanel.tsx
    - ui/src/components/Rt2DailyWikiPanel.tsx
  action: |
    Create ui/src/components/Rt2DailyReportPanel.tsx:
    - 3패널 레이아웃 (좌측 OKR 트리, 중앙 보고서, 우측 상세/자비스)
    - Task 카드 목록 (드래그앤드롭)
    - To-Do 작성/편집 폼
    - 산출물 정의 필드 (deliverable_name, deliverable_type, deliverable_link)
    - 금화 현황 표시
    - 상태 배지 (draft/submitted/approved/returned)
    - [AI 자산화] 버튼 stub
    - useDailyReport hook integration
    Follow existing panel patterns from Rt2TaskPanel.
  acceptance_criteria:
    - "grep -r 'Rt2DailyReportPanel' ui/src/components/Rt2DailyReportPanel.tsx returns component"
    - "grep -r '3패널\\|three-panel\\|threePanel' ui/src/components/Rt2DailyReportPanel.tsx returns layout"
    - "grep -r 'deliverable' ui/src/components/Rt2DailyReportPanel.tsx returns deliverable fields"

- id: ui-tab
  objective: Add Daily Report tab to ProjectDetail
  depends_on: [ui-panel]
  files_modified:
    - ui/src/pages/ProjectDetail.tsx
  read_first:
    - ui/src/pages/ProjectDetail.tsx
  action: |
    Add 'daily-report' tab type and import to ProjectDetail.tsx:
    - import Rt2DailyReportPanel from '../components/Rt2DailyReportPanel'
    - Add tab case: case 'daily-report': return <Rt2DailyReportPanel ... />
    - Add tab bar item with icon
  acceptance_criteria:
    - "grep 'Rt2DailyReportPanel' ui/src/pages/ProjectDetail.tsx returns import"
    - "grep 'daily-report.*tab\\|tab.*daily-report' ui/src/pages/ProjectDetail.tsx returns case"
```

---

## Wave 4: Integration + Build

### PLAN-07: Build + Typecheck

**Objective:** 전체 빌드 및 타입체크 검증

**Tasks:**

```yaml
- id: typecheck
  objective: Run typecheck on all packages
  depends_on: [ui-tab]
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
  PLAN-01: DB Schema     → PLAN-02 (depends_on)
  PLAN-02: Service       → PLAN-03 (depends_on)
  PLAN-03: Routes        → Wave 2

Wave 2 (병렬):
  PLAN-04: Shared Types  → PLAN-05 (depends_on)
  PLAN-05: API Client    → Wave 3

Wave 3:
  PLAN-06: UI Panel     → Wave 4

Wave 4:
  PLAN-07: Build
```

---

## 기존 구현 참고

| 파일 | 용도 |
|------|------|
| `ui/src/components/Rt2TaskPanel.tsx` | 패널 구조参照 |
| `ui/src/components/Rt2DailyWikiPanel.tsx` | 일일 위키参照 |
| `server/src/services/rt2-task-mesh.ts` | 서비스 패턴参照 |
| `packages/shared/src/types/rt2-task.ts` | 타입 정의参照 |
| `ui/src/api/rt2-task.ts` | API 클라이언트参照 |
