# Phase 50: Work Card Editing and Board Controls - Research

**Researched:** 2026-04-30 [VERIFIED: current_date]
**Domain:** RealTycoon2 daily work board quick edit, board controls, and RT2 metadata ownership [VERIFIED: .planning/phases/50-work-card-editing-and-board-controls/50-CONTEXT.md]
**Confidence:** HIGH for existing contracts and test paths, MEDIUM for approval-waiting filter semantics [VERIFIED: codebase grep]

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Quick Edit Surface
- **D-01:** Keep quick edit inside the board context, not as a deep issue-detail navigation flow. Use compact inline controls or a small card-level edit panel so operators can adjust repeated work fields without leaving `daily-work`.
- **D-02:** The default card view stays scan-first. Editing controls should appear on intent, such as an edit button, expanded area, focused field, or compact popover, rather than making every card permanently form-heavy.
- **D-03:** Save title, lane/status, deliverable, base price, quality state, and OKR badge independently enough that one failed field does not make the whole card look saved. Show Korean pending/success/failure feedback near the edited card.

#### Editable Fields And Ownership
- **D-04:** Lane/status editing should continue through the Phase 49 daily report save path for daily lane state and must keep daily wiki/activity materialization intact.
- **D-05:** Title editing should update the underlying To-Do issue title through the existing issue/task route pattern rather than storing a daily-board-only title override.
- **D-06:** Deliverable title/type/required/base-price editing should reuse RT2 deliverable/work product metadata conventions from the task engine and work-board services. Do not create a parallel deliverable table for daily cards.
- **D-07:** Base price editing should write the same RT2 deliverable metadata used by `rt2DailyReportService` to compute `basePriceTotal`, so card badges, Gold summary, and economy evidence stay consistent.
- **D-08:** Quality state editing should reuse `Rt2BoardQualityStatus` where possible (`none`, `pending_review`, `reviewed`, `needs_work`) and map the daily card's current summary label to that richer board-control vocabulary.
- **D-09:** OKR badge editing should attach or clear the task-level `goalId`/profile goal relation, with project goal as fallback display only. The UI should distinguish "OKR inherited from project" from "OKR directly set on task" if the data contract can expose that without broad schema churn.

#### Filter And Search Controls
- **D-10:** Implement the required filters as explicit operator chips/toggles: `오늘 업무`, `내 업무`, `산출물 누락`, `승인 대기`, and `품질 이슈`.
- **D-11:** Filters should be combinable and should filter cards across all lanes while preserving lane grouping. Empty lanes remain visible with Korean empty text so operators know the filter is active.
- **D-12:** `오늘 업무` should anchor to the board `reportDate`; `내 업무` should anchor to the current board actor/user. Do not add a new global assignee model unless existing user/member data is already available.
- **D-13:** `산출물 누락` should use existing `missing_deliverable` gap flags and `deliverableCount === 0`.
- **D-14:** `품질 이슈` should include cards with `qualityStatus` requiring review or rework, including `pending_review` and `needs_work` if the richer status is exposed.
- **D-15:** `승인 대기` should use existing approval/review signals if available in work products or board metadata. If no precise approval field exists, implement the narrowest safe proxy and label it conservatively, then document the limitation in tests or code context.
- **D-16:** Search should match visible card text and key metadata: To-Do title, task title, assignee, deliverable title, OKR/goal title, and status/quality labels. Prefer client-side filtering for the current board payload unless dataset size or missing metadata forces a server query.

#### Sort And Lane Order
- **D-17:** Sorting must not mutate persisted lane/status or manual lane movement. Treat sort as view order unless the user performs an explicit lane/status edit.
- **D-18:** Provide a small set of practical sort modes: recently updated, due date if available, missing evidence first, quality issue first, and price/gold descending. The default should preserve the server/current board order from Phase 49.
- **D-19:** Search/filter/sort state should survive normal board refreshes during the session but does not need a new persisted user preference unless an existing local preference pattern is trivial to reuse.

#### Data Contract Shape
- **D-20:** Prefer extending the existing daily board response with the minimum missing edit/control fields over introducing a second board read model. The daily board should remain the primary surface from Phase 49.
- **D-21:** Reuse `rt2WorkBoardService.getBoardOverview` and `updateBoardCard` for due/quality/price-style metadata where it fits, but avoid forcing daily board callers to stitch inconsistent data client-side if the server can return a cohesive daily card payload.
- **D-22:** If new route endpoints are needed, keep them narrow and board-owned: update card title/status, upsert card deliverable/base price, update card quality, update task OKR. Validate shared schemas in `packages/shared` and route tests together.

#### Product Copy And Layout
- **D-23:** All product-facing control labels, empty states, save states, validation messages, and filter chips should be Korean-first and RealTycoon2-facing.
- **D-24:** Keep the board utilitarian and dense. Avoid hero sections, explanatory marketing copy, or large nested cards; this is a repeated daily operations surface.
- **D-25:** Use stable compact controls with no layout jumps: fixed-height toolbar, predictable lane widths, compact chips, and edit affordances that do not cause neighboring cards to shift unexpectedly.

#### Verification
- **D-26:** Add or update focused `Rt2DailyBoard` component tests for quick edit controls, Korean save/failure states, required filters, search, and sort preserving lane grouping.
- **D-27:** Add shared/server route tests for any new update contracts covering title, deliverable/base price, quality, OKR, and approval/quality filter semantics.
- **D-28:** Keep existing daily report route tests green and extend them where daily board payload fields or save materialization change.
- **D-29:** Verification should include `pnpm typecheck` and focused Vitest tests for changed UI/shared/server files. Run `pnpm test` if feasible; if Windows host constraints or long-running embedded Postgres suites block it, record focused evidence explicitly.

### the agent's Discretion
- Exact edit affordance, provided the board remains scan-first and quick edits do not require deep navigation.
- Exact filter toolbar visual treatment, provided the five required filter concepts are visible, composable, and Korean-labeled.
- Whether filter/search/sort are implemented fully client-side or with small server support, based on the fields available in the daily board payload.

### Deferred Ideas (OUT OF SCOPE)
- One-Liner capture appearing immediately in a board lane or inbox belongs to Phase 51.
- One-Liner suggested work type, deliverable, price/quality hint, and OKR/KPI review belongs to Phase 51.
- Mobile/native/inbound draft duplicate warning and source evidence belongs to Phase 51.
- Jarvis/wiki/graph/economy detail panels and broader identity regression gate belong to Phase 52.
- Persisted personal board-control preferences can be a future enhancement unless an existing local preference pattern makes it nearly free.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| BOARD-04 | 운영자는 카드 quick edit로 제목, 상태, 산출물, 기준가, 품질 평가, OKR badge를 별도 깊은 화면 이동 없이 수정할 수 있다. [VERIFIED: .planning/REQUIREMENTS.md] | Existing daily lane save path, issue patch route, work product metadata, work-board card quality metadata, and task profile goal ownership are identified below. [VERIFIED: server/src/services/rt2-daily-report.ts; server/src/routes/issues.ts; packages/db/src/schema/issue_work_products.ts; packages/db/src/schema/rt2_work_board.ts; packages/db/src/schema/rt2_v33_task_profiles.ts] |
| BOARD-05 | 운영자는 board filter/sort/search를 사용해 오늘 업무, 내 업무, 산출물 누락, 승인 대기, 품질 이슈 카드를 빠르게 찾을 수 있다. [VERIFIED: .planning/REQUIREMENTS.md] | Existing card fields cover report date, actor user, missing deliverable gaps, quality summary, titles, assignee, price, and updated time; approval waiting needs a conservative proxy or new explicit field. [VERIFIED: packages/shared/src/types/rt2-daily-report.ts; server/src/services/rt2-daily-report.ts; rg reviewState/approval] |
</phase_requirements>

## Summary

Phase 50 should extend the Phase 49 `Rt2DailyBoard` rather than create another board surface. [VERIFIED: .planning/phases/50-work-card-editing-and-board-controls/50-CONTEXT.md] The current daily board already reads `Rt2DailyBoard`, groups cards by `todo/doing/done`, saves per-card lane/bucket/progress/note through `PUT /companies/:companyId/rt2/daily-report/cards/:todoIssueId`, emits daily report/wiki live events, logs activity, and materializes daily wiki after save. [VERIFIED: ui/src/components/Rt2DailyBoard.tsx; ui/src/api/rt2-daily-report.ts; server/src/routes/rt2-daily-report.ts; server/src/services/rt2-daily-report.ts]

Quick edit must be split by data ownership. [VERIFIED: codebase grep] Lane/progress/note stays on daily report cards; title and direct issue `goalId` are issue fields; task-level OKR is also represented in `rt2_v33_task_profiles.goalId`; deliverable title/type/required/base price are encoded in `issue_work_products` rows with RT2 metadata; quality status has richer vocabulary in `Rt2BoardQualityStatus` and `rt2_work_board_cards.quality_status`. [VERIFIED: packages/shared/src/types/rt2-daily-report.ts; packages/shared/src/types/rt2-task.ts; packages/db/src/schema/issue_work_products.ts; packages/db/src/schema/rt2_v33_task_profiles.ts; packages/db/src/schema/rt2_work_board.ts]

Board controls can mostly be client-side after extending the daily board payload with missing visible metadata such as deliverable titles, due date, direct/inherited OKR details, richer quality status, and any approval proxy. [VERIFIED: packages/shared/src/types/rt2-daily-report.ts; server/src/services/rt2-daily-report.ts] The riskiest filter is `승인 대기`: current daily cards expose `qualityStatus` derived from deliverable `reviewState`, but there is no explicit daily-card approval-waiting boolean in the shared daily board contract. [VERIFIED: packages/shared/src/types/rt2-daily-report.ts; server/src/services/rt2-daily-report.ts; rg reviewState/approval]

**Primary recommendation:** Add narrow daily-board-owned update endpoints and minimally enrich `Rt2DailyReportCard`; implement filter/search/sort in `Rt2DailyBoard` as view state unless a field is missing from the cohesive daily payload. [VERIFIED: .planning/phases/50-work-card-editing-and-board-controls/50-CONTEXT.md; ui/src/components/Rt2DailyBoard.tsx]

## Project Constraints (from AGENTS.md)

- User-facing communication, progress reports, explanations, and final reports must be Korean-first. [VERIFIED: AGENTS.md]
- Product-facing UI should use RealTycoon2 terminology over Paperclip legacy terms. [VERIFIED: AGENTS.md]
- The repo is a pnpm monorepo with `packages/*`, `server/`, `ui/`, and `cli/`. [VERIFIED: AGENTS.md]
- Dev default uses embedded PostgreSQL/PGlite with `DATABASE_URL` unset. [VERIFIED: AGENTS.md]
- Do not run `pnpm test:e2e` as the default verification path. [VERIFIED: AGENTS.md]
- Do not commit `pnpm-lock.yaml` changes in PRs. [VERIFIED: AGENTS.md]
- Default verification is `pnpm typecheck && pnpm test`, with focused tests acceptable when host constraints block broader suites. [VERIFIED: AGENTS.md; .planning/STATE.md]
- Do not over-plan or run unrelated rewrites. [VERIFIED: AGENTS.md]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Card quick edit UI and per-field feedback | Browser / Client | API / Backend | `Rt2DailyBoard` owns the visible board and current card save feedback, while server endpoints own persistence. [VERIFIED: ui/src/components/Rt2DailyBoard.tsx; server/src/routes/rt2-daily-report.ts] |
| Daily lane/status persistence | API / Backend | Database / Storage | Daily lane state is stored in `rt2_v33_daily_report_cards` through `saveDailyCard`; route also materializes wiki. [VERIFIED: server/src/services/rt2-daily-report.ts; server/src/routes/rt2-daily-report.ts] |
| To-Do title edit | API / Backend | Database / Storage | `PATCH /issues/:id` accepts `title` through `updateIssueRouteSchema` and syncs issue references on title changes. [VERIFIED: server/src/routes/issues.ts; packages/shared/src/validators/issue.ts] |
| Deliverable/base-price edit | API / Backend | Database / Storage | RT2 deliverables are `issue_work_products` with metadata including `rt2Deliverable`, `rt2Required`, `rt2Type`, and `rt2BasePrice`. [VERIFIED: server/src/__tests__/rt2-task-routes.test.ts; packages/db/src/schema/issue_work_products.ts] |
| Quality edit | API / Backend | Database / Storage | Work-board card quality is persisted in `rt2_work_board_cards.quality_status` and validated by `rt2BoardQualityStatusSchema`. [VERIFIED: packages/db/src/schema/rt2_work_board.ts; packages/shared/src/validators/rt2-task.ts] |
| OKR badge edit | API / Backend | Database / Storage | Daily board reads task profile goal and project fallback; issue updates also support `goalId`, so planner must choose a single direct-task source and avoid ambiguous dual writes. [VERIFIED: server/src/services/rt2-daily-report.ts; server/src/services/issues.ts; packages/db/src/schema/rt2_v33_task_profiles.ts] |
| Filter/search/sort controls | Browser / Client | API / Backend | Context locks prefer client-side filtering for current board payload unless missing metadata forces a server query. [VERIFIED: .planning/phases/50-work-card-editing-and-board-controls/50-CONTEXT.md] |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| React | repo `^19.0.0`; npm latest `19.2.5`, modified 2026-04-28 | Component state and board UI | Existing UI is React and `Rt2DailyBoard` is a React component. [VERIFIED: ui/package.json; npm registry] |
| TypeScript | repo `^5.7.3` | Shared contracts across UI/server/packages | Repo scripts use `tsc` and shared package types. [VERIFIED: package.json; ui/package.json; server/package.json] |
| Zod | repo `^3.24.2`; npm latest `4.4.1`, modified 2026-04-29 | Request validation and shared schemas | Existing RT2 routes use shared Zod validators via `validate(...)`. [VERIFIED: server/src/routes/rt2-daily-report.ts; packages/shared/src/validators/rt2-task.ts; npm registry] |
| Express | repo `^5.1.0` | API routing | Server RT2 routes are Express routers. [VERIFIED: server/package.json; server/src/routes/rt2-daily-report.ts] |
| Drizzle ORM | repo `^0.38.4` | Database queries and schema | Existing services and schema use Drizzle tables/query helpers. [VERIFIED: server/src/services/rt2-daily-report.ts; packages/db/src/schema/rt2_work_board.ts] |
| Vitest | repo `^3.0.5`; npm latest `4.1.5`, modified 2026-04-23 | Unit/component/route tests | Existing focused tests use Vitest and jsdom. [VERIFIED: package.json; ui/src/components/Rt2DailyBoard.test.tsx; npm registry] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@tanstack/react-query` | repo `^5.90.21`; npm latest `5.100.6`, modified 2026-04-28 | Query invalidation and mutation state | Use in page/container layer if daily board API calls are managed there. [VERIFIED: ui/package.json; npm registry] |
| `@dnd-kit/core` | repo `^6.3.1` | Drag/drop board patterns | Existing `KanbanBoard` uses DnD patterns; `Rt2DailyBoard` currently uses native drag/drop. [VERIFIED: ui/package.json; ui/src/components/KanbanBoard.tsx; ui/src/components/Rt2DailyBoard.tsx] |
| `lucide-react` | repo `^0.574.0` | Compact toolbar/edit icons | Existing UI dependency supports icon buttons for dense controls. [VERIFIED: ui/package.json] |
| `supertest` | repo `^7.0.0` | Express route tests | Existing RT2 route suites use supertest. [VERIFIED: server/package.json; server/src/__tests__/rt2-daily-report-routes.test.ts] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Extending `Rt2DailyBoard` | New board component/read model | New read model contradicts D-20 and risks inconsistent daily/wiki materialization. [VERIFIED: .planning/phases/50-work-card-editing-and-board-controls/50-CONTEXT.md; server/src/services/rt2-daily-report.ts] |
| Client-side filter/search/sort | Server-side query parameters | Server support is only needed if enriched fields are unavailable or card volume grows beyond current payload assumptions. [VERIFIED: .planning/phases/50-work-card-editing-and-board-controls/50-CONTEXT.md] |
| Existing RT2 metadata tables | New daily-card deliverable table | Parallel deliverable storage would break `basePriceTotal` and RT2 deliverable conventions. [VERIFIED: .planning/phases/50-work-card-editing-and-board-controls/50-CONTEXT.md; server/src/services/rt2-daily-report.ts] |

**Installation:**
```bash
# No new package is required for the recommended plan. [VERIFIED: package.json; ui/package.json; server/package.json]
pnpm install
```

**Version verification:**
```bash
npm view react version time.modified
npm view @tanstack/react-query version time.modified
npm view zod version time.modified
npm view vitest version time.modified
```

## Architecture Patterns

### System Architecture Diagram

```text
Operator on /daily-work
  |
  v
Rt2DailyBoard toolbar + card quick edit
  |
  +--> View-only controls: filter/search/sort current board cards
  |      |
  |      v
  |    Preserve lane grouping and do not persist order
  |
  +--> Lane/progress/note edit
  |      |
  |      v
  |    PUT /companies/:companyId/rt2/daily-report/cards/:todoIssueId
  |      |
  |      v
  |    rt2DailyReportService.saveDailyCard
  |      |
  |      +--> rt2_v33_daily_report_cards
  |      +--> activityLog
  |      +--> materializeDailyWikiPage
  |
  +--> Title edit
  |      |
  |      v
  |    PATCH /issues/:todoIssueId { title }
  |
  +--> Deliverable/base price edit
  |      |
  |      v
  |    Narrow board-owned route or task/work-product service
  |      |
  |      v
  |    issue_work_products.metadata.rt2BasePrice / rt2Required / rt2Type
  |
  +--> Quality edit
  |      |
  |      v
  |    PATCH /companies/:companyId/rt2/work-board/cards/:issueId
  |      |
  |      v
  |    rt2_work_board_cards.quality_status
  |
  +--> OKR edit
         |
         v
       task-level goal relation / profile goal
         |
         v
       daily card exposes direct vs inherited OKR display
```

All arrows above follow existing API/service boundaries except the proposed narrow deliverable/base-price and OKR daily-board edit routes, which require planner tasks. [VERIFIED: ui/src/api/rt2-daily-report.ts; ui/src/api/rt2-tasks.ts; server/src/routes/rt2-daily-report.ts; server/src/routes/rt2-tasks.ts; server/src/routes/issues.ts]

### Recommended Project Structure

```text
packages/shared/src/
├── types/rt2-daily-report.ts        # Extend daily card read contract. [VERIFIED: file exists]
├── validators/rt2-daily-report.ts   # Add narrow board edit validators if route-owned here. [VERIFIED: file exists]
└── validators/rt2-task.ts           # Reuse quality/deliverable schemas where appropriate. [VERIFIED: file exists]
server/src/
├── routes/rt2-daily-report.ts       # Board-owned narrow update endpoints. [VERIFIED: file exists]
├── services/rt2-daily-report.ts     # Cohesive daily card payload and wiki-preserving lane saves. [VERIFIED: file exists]
├── routes/rt2-tasks.ts              # Existing work-board metadata route. [VERIFIED: file exists]
└── __tests__/                       # Daily report and task route coverage. [VERIFIED: files exist]
ui/src/
├── components/Rt2DailyBoard.tsx     # Toolbar, quick edit surface, client controls. [VERIFIED: file exists]
├── components/Rt2DailyBoard.test.tsx # Focused component tests. [VERIFIED: file exists]
└── api/rt2-daily-report.ts          # Daily board client helpers. [VERIFIED: file exists]
```

### Pattern 1: Keep Daily Lane Save On Daily Report Route

**What:** Persist daily lane/progress/note through `saveDailyCard`, not through work-board metadata. [VERIFIED: server/src/services/rt2-daily-report.ts]
**When to use:** Any edit that affects daily lane state, progress, bucket, note, activity log, or daily wiki. [VERIFIED: server/src/services/rt2-daily-report.ts]
**Example:**
```typescript
// Source: ui/src/api/rt2-daily-report.ts [VERIFIED: codebase]
saveCard: (companyId: string, todoIssueId: string, data: UpsertRt2DailyReportCard) =>
  api.put<Rt2DailyReportSaveResponse>(
    `/companies/${encodeURIComponent(companyId)}/rt2/daily-report/cards/${encodeURIComponent(todoIssueId)}`,
    data,
  )
```

### Pattern 2: Reuse RT2 Work-Board Quality Metadata

**What:** Use `Rt2BoardQualityStatus` and `updateRt2BoardCardSchema` for richer quality states. [VERIFIED: packages/shared/src/types/rt2-task.ts; packages/shared/src/validators/rt2-task.ts]
**When to use:** Card quality edit and quality issue filter enrichment. [VERIFIED: packages/shared/src/types/rt2-task.ts]
**Example:**
```typescript
// Source: packages/shared/src/validators/rt2-task.ts [VERIFIED: codebase]
export const rt2BoardQualityStatusSchema = z.enum(["none", "pending_review", "reviewed", "needs_work"]);
```

### Pattern 3: Derived Daily Board Payload Stays Cohesive

**What:** Add missing display/control fields in `Rt2DailyReportCard` and compute them in `listCards`. [VERIFIED: packages/shared/src/types/rt2-daily-report.ts; server/src/services/rt2-daily-report.ts]
**When to use:** Search/filter/sort needs deliverable title, due date, goal title, direct/inherited OKR status, approval proxy, or richer quality state. [VERIFIED: .planning/phases/50-work-card-editing-and-board-controls/50-CONTEXT.md]
**Example:**
```typescript
// Source: server/src/services/rt2-daily-report.ts [VERIFIED: codebase]
const deliverableCount = allDeliverables.length;
const submittedDeliverableCount = allDeliverables.filter(isSubmittedDeliverable).length;
const basePriceTotal = allDeliverables.reduce((total, deliverable) => total + readBasePrice(deliverable), 0);
```

### Anti-Patterns to Avoid

- **Daily-card title override:** It would diverge from the underlying To-Do issue and contradict D-05. [VERIFIED: .planning/phases/50-work-card-editing-and-board-controls/50-CONTEXT.md]
- **Parallel deliverable table:** It would bypass `issue_work_products` and break `basePriceTotal` derivation. [VERIFIED: server/src/services/rt2-daily-report.ts; packages/db/src/schema/issue_work_products.ts]
- **Persisting sorted order as lane/status:** Sorting is view order only per D-17. [VERIFIED: .planning/phases/50-work-card-editing-and-board-controls/50-CONTEXT.md]
- **Making every card a full form by default:** The board must stay scan-first and dense. [VERIFIED: .planning/phases/50-work-card-editing-and-board-controls/50-CONTEXT.md]
- **Client stitching multiple inconsistent board read models:** D-21 prefers a cohesive daily payload when server can provide it. [VERIFIED: .planning/phases/50-work-card-editing-and-board-controls/50-CONTEXT.md]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| API validation | Ad hoc route checks only | Zod schemas in `packages/shared` | Existing RT2 routes validate shared schemas consumed by UI/server. [VERIFIED: packages/shared/src/validators/rt2-daily-report.ts; server/src/routes/rt2-daily-report.ts] |
| Daily activity/wiki side effects | Direct DB update from UI-specific endpoint | `saveDailyCard` path for lane/progress/note | It logs activity and materializes daily wiki. [VERIFIED: server/src/services/rt2-daily-report.ts] |
| Deliverable storage | New daily deliverable table | `issue_work_products` with RT2 metadata | Existing task creation and daily summary use that shape. [VERIFIED: server/src/__tests__/rt2-task-routes.test.ts; server/src/services/rt2-daily-report.ts] |
| Quality vocabulary | New string enum | `Rt2BoardQualityStatus` | It already includes `needs_work` beyond daily summary. [VERIFIED: packages/shared/src/types/rt2-task.ts] |
| Route tests | Manual request mocks only | Existing Express + supertest + embedded Postgres suites | Current RT2 route tests verify persistence and route behavior. [VERIFIED: server/src/__tests__/rt2-daily-report-routes.test.ts; server/src/__tests__/rt2-task-routes.test.ts] |

**Key insight:** Phase 50 is not a greenfield board; correctness depends on keeping each edit routed to the existing owner so daily wiki, work-board metadata, issue title, deliverable economics, and OKR context do not drift. [VERIFIED: codebase grep; .planning/phases/50-work-card-editing-and-board-controls/50-CONTEXT.md]

## Common Pitfalls

### Pitfall 1: Saving Daily Lane Through The Wrong Endpoint
**What goes wrong:** Lane movement appears saved but daily wiki/activity materialization is skipped. [VERIFIED: server/src/routes/rt2-daily-report.ts; server/src/services/rt2-daily-report.ts]
**Why it happens:** Work-board metadata also has card routes, but those routes do not materialize daily wiki. [VERIFIED: server/src/routes/rt2-tasks.ts]
**How to avoid:** Keep lane/status-on-board saves on `rt2DailyReportService.saveDailyCard`. [VERIFIED: server/src/services/rt2-daily-report.ts]
**Warning signs:** New lane endpoint does not emit `rt2.daily-report.updated` and `rt2.daily-wiki.updated`. [VERIFIED: server/src/routes/rt2-daily-report.ts]

### Pitfall 2: Base Price Written To `priceGold`
**What goes wrong:** Daily `basePriceTotal` and Gold summary do not update because daily service reads `issueWorkProducts.metadata.rt2BasePrice`, not `rt2_work_board_cards.priceGold`. [VERIFIED: server/src/services/rt2-daily-report.ts; packages/db/src/schema/rt2_work_board.ts]
**Why it happens:** Work-board card metadata has `priceGold`, but RT2 deliverable definitions use work-product metadata. [VERIFIED: packages/shared/src/types/rt2-task.ts; server/src/__tests__/rt2-task-routes.test.ts]
**How to avoid:** Treat deliverable base price as deliverable metadata; use `priceGold` only if the planner intentionally separates board display price from deliverable base price. [VERIFIED: .planning/phases/50-work-card-editing-and-board-controls/50-CONTEXT.md]
**Warning signs:** UI badge changes but `cockpit.summary.goldImpact` stays unchanged after refresh. [VERIFIED: server/src/services/rt2-daily-report.ts]

### Pitfall 3: Approval Waiting Filter Has No Precise Daily Field
**What goes wrong:** `승인 대기` is mislabeled as if it means formal approval while it only means pending review. [VERIFIED: packages/shared/src/types/rt2-daily-report.ts; rg reviewState/approval]
**Why it happens:** Daily card exposes `qualityStatus: none | pending_review | reviewed`; formal approvals live in other approval/governance surfaces. [VERIFIED: packages/shared/src/types/rt2-daily-report.ts; ui/src/api/approvals.ts; packages/shared/src/types/rt2-governance.ts]
**How to avoid:** Either add an explicit `approvalWaiting` field from a verified source or label the proxy conservatively in code/tests. [VERIFIED: .planning/phases/50-work-card-editing-and-board-controls/50-CONTEXT.md]
**Warning signs:** Tests assert `승인 대기` solely from `qualityStatus === "pending_review"` without documenting the proxy. [VERIFIED: .planning/phases/50-work-card-editing-and-board-controls/50-CONTEXT.md]

### Pitfall 4: OKR Direct vs Inherited Context Is Collapsed
**What goes wrong:** User cannot distinguish a direct task OKR from project fallback display. [VERIFIED: .planning/phases/50-work-card-editing-and-board-controls/50-CONTEXT.md]
**Why it happens:** Current daily card only exposes `okrContextStatus`, while service internally reads task profile goal and project fallback. [VERIFIED: packages/shared/src/types/rt2-daily-report.ts; server/src/services/rt2-daily-report.ts]
**How to avoid:** Extend daily payload with direct task goal id/title and inherited fallback metadata before UI edit. [VERIFIED: server/src/services/rt2-daily-report.ts]
**Warning signs:** OKR edit clears project fallback or shows “OKR 연결” without source. [VERIFIED: .planning/phases/50-work-card-editing-and-board-controls/50-CONTEXT.md]

### Pitfall 5: Search Only Checks Title
**What goes wrong:** Operators cannot find cards by assignee, deliverable, OKR, or quality label. [VERIFIED: .planning/phases/50-work-card-editing-and-board-controls/50-CONTEXT.md]
**Why it happens:** Current card payload lacks deliverable titles and goal titles at card level; trace rows contain goal paths separately. [VERIFIED: packages/shared/src/types/rt2-daily-report.ts]
**How to avoid:** Build a per-card searchable text index from enriched card fields and trace metadata. [VERIFIED: packages/shared/src/types/rt2-daily-report.ts]
**Warning signs:** Search tests only cover `todoTitle`. [VERIFIED: .planning/phases/50-work-card-editing-and-board-controls/50-CONTEXT.md]

## Code Examples

### Daily Board Save Contract
```typescript
// Source: packages/shared/src/validators/rt2-daily-report.ts [VERIFIED: codebase]
export const upsertRt2DailyReportCardSchema = z.object({
  projectId: z.string().uuid(),
  reportDate: rt2DailyReportDateSchema,
  lane: rt2DailyLaneSchema,
  bucketLabel: z.string().trim().max(40).nullable().optional(),
  progressPercent: z.number().int().min(0).max(100),
  note: z.string().trim().max(500).nullable().optional(),
});
```

### Work-Board Card Metadata Contract
```typescript
// Source: packages/shared/src/validators/rt2-task.ts [VERIFIED: codebase]
export const updateRt2BoardCardSchema = z.object({
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  qualityStatus: rt2BoardQualityStatusSchema.optional(),
  priceGold: z.number().int().min(0).nullable().optional(),
  detailNotes: z.string().trim().max(2000).nullable().optional(),
});
```

### Existing RT2 Deliverable Metadata Shape
```typescript
// Source: server/src/__tests__/rt2-task-routes.test.ts [VERIFIED: codebase]
metadata: expect.objectContaining({
  rt2Deliverable: true,
  rt2State: "defined",
  rt2Type: "document",
  rt2Owner: "task",
  rt2Required: true,
  rt2BasePrice: 250000,
})
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `today/support_1/support_2` daily lane vocabulary | `todo/doing/done` with Korean labels `할 일/진행 중/완료` | Phase 49, 2026-04-30 [VERIFIED: .planning/phases/49-daily-work-kanban-core/49-CONTEXT.md; packages/shared/src/types/rt2-daily-report.ts] | Phase 50 should not reintroduce old lane vocabulary. [VERIFIED: .planning/phases/49-daily-work-kanban-core/49-CONTEXT.md] |
| Daily board as secondary knowledge tab | `/daily-work` as first operational work surface | Phase 49, 2026-04-30 [VERIFIED: .planning/ROADMAP.md; ui/src/App.tsx] | Quick edit and controls belong in `daily-work`. [VERIFIED: .planning/phases/50-work-card-editing-and-board-controls/50-CONTEXT.md] |
| Daily card exposes only summary quality enum | Work-board metadata has richer `needs_work` status | Existing before Phase 50 [VERIFIED: packages/shared/src/types/rt2-daily-report.ts; packages/shared/src/types/rt2-task.ts] | Daily board payload likely needs richer quality mapping. [VERIFIED: .planning/phases/50-work-card-editing-and-board-controls/50-CONTEXT.md] |

**Deprecated/outdated:**
- Old daily lane names `today`, `support_1`, and `support_2` remain compatibility-normalized in service but are not the Phase 50 UI vocabulary. [VERIFIED: server/src/services/rt2-daily-report.ts; .planning/phases/49-daily-work-kanban-core/49-CONTEXT.md]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The current board payload is small enough for client-side filter/search/sort during Phase 50. [ASSUMED] | Summary, Architecture Patterns | If board payloads become large, planner must add server query parameters and indexes. |

## Open Questions

1. **What is the exact formal source for `승인 대기` on a daily card?**
   - What we know: Daily cards derive `qualityStatus` from deliverable `reviewState`; separate approval/governance APIs exist. [VERIFIED: server/src/services/rt2-daily-report.ts; ui/src/api/approvals.ts; packages/shared/src/types/rt2-governance.ts]
   - What's unclear: No daily-card field currently ties a card to a pending approval id/status. [VERIFIED: packages/shared/src/types/rt2-daily-report.ts]
   - Recommendation: Add explicit `approvalWaiting` only if a reliable join exists; otherwise use a conservative proxy such as pending review and document test wording. [VERIFIED: .planning/phases/50-work-card-editing-and-board-controls/50-CONTEXT.md]

2. **Should OKR edit write `issues.goalId`, `rt2_v33_task_profiles.goalId`, or both?**
   - What we know: Daily board currently reads task profile goal and project fallback, while issue update supports `goalId`. [VERIFIED: server/src/services/rt2-daily-report.ts; server/src/services/issues.ts]
   - What's unclear: Phase context says task-level `goalId`/profile goal relation, which suggests planner should prefer `rt2_v33_task_profiles.goalId` for task OKR source. [VERIFIED: .planning/phases/50-work-card-editing-and-board-controls/50-CONTEXT.md; packages/db/src/schema/rt2_v33_task_profiles.ts]
   - Recommendation: Plan one narrow service method that updates the task profile goal and, only if required by existing issue surfaces, synchronizes `issues.goalId` intentionally. [VERIFIED: codebase grep]

3. **Should deliverable quick edit target task-level or To-Do-level work products by default?**
   - What we know: Daily summary merges task and todo deliverables and tracks `taskDeliverableCount`. [VERIFIED: server/src/services/rt2-daily-report.ts]
   - What's unclear: UI copy must make owner clear if both task and todo deliverables exist. [VERIFIED: .planning/phases/50-work-card-editing-and-board-controls/50-CONTEXT.md]
   - Recommendation: Expose deliverable owner in payload and default edits to existing primary/first deliverable, with create-upsert scoped to the card's To-Do only if no deliverable exists. [ASSUMED]

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | `pnpm typecheck`, Vitest, build scripts | ✓ | v22.17.0 | None needed. [VERIFIED: shell `node --version`] |
| pnpm | Workspace scripts | ✓ | 9.15.4 | None needed. [VERIFIED: shell `pnpm --version`; package.json] |
| npm | Registry version checks | ✓ | 10.9.2 | Use `pnpm view` if npm unavailable. [VERIFIED: shell `npm --version`] |
| Embedded PostgreSQL test support | Server route tests | Host-dependent | Existing tests auto-skip when unsupported | Focused UI/shared tests plus documented skip evidence. [VERIFIED: server/src/__tests__/rt2-daily-report-routes.test.ts; .planning/STATE.md] |

**Missing dependencies with no fallback:**
- None found for planning/research. [VERIFIED: shell probes]

**Missing dependencies with fallback:**
- Embedded Postgres may be unsupported on this Windows host; existing suites use `getEmbeddedPostgresTestSupport()` and `describe.skip`. [VERIFIED: server/src/__tests__/rt2-daily-report-routes.test.ts; server/src/__tests__/rt2-task-routes.test.ts]

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest repo `^3.0.5`; npm latest `4.1.5`. [VERIFIED: package.json; npm registry] |
| Config file | No root vitest config found in requested scan; tests use file-level jsdom directive where needed. [VERIFIED: rg test files; ui/src/components/Rt2DailyBoard.test.tsx] |
| Quick run command | `pnpm exec vitest run ui/src/components/Rt2DailyBoard.test.tsx packages/shared/src/rt2-daily-report.test.ts server/src/__tests__/rt2-daily-report-routes.test.ts server/src/__tests__/rt2-task-routes.test.ts` [VERIFIED: package.json; files exist] |
| Full suite command | `pnpm test` [VERIFIED: package.json; AGENTS.md] |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| BOARD-04 | Quick edit title/lane/deliverable/base price/quality/OKR from board context | Component + route + shared validator | `pnpm exec vitest run ui/src/components/Rt2DailyBoard.test.tsx server/src/__tests__/rt2-daily-report-routes.test.ts server/src/__tests__/rt2-task-routes.test.ts packages/shared/src/rt2-daily-report.test.ts` | ✅ existing files; new cases needed. [VERIFIED: rg tests] |
| BOARD-05 | Filter chips, search, sort preserve lane grouping and do not persist order | Component test | `pnpm exec vitest run ui/src/components/Rt2DailyBoard.test.tsx` | ✅ existing file; new cases needed. [VERIFIED: ui/src/components/Rt2DailyBoard.test.tsx] |
| BOARD-05 | Approval/quality filter semantics match payload fields | Route/shared test | `pnpm exec vitest run server/src/__tests__/rt2-daily-report-routes.test.ts packages/shared/src/rt2-daily-report.test.ts` | ✅ existing files; new fields/cases needed. [VERIFIED: rg tests] |

### Sampling Rate

- **Per task commit:** `pnpm exec vitest run ui/src/components/Rt2DailyBoard.test.tsx packages/shared/src/rt2-daily-report.test.ts` [VERIFIED: files exist]
- **Per wave merge:** `pnpm exec vitest run ui/src/components/Rt2DailyBoard.test.tsx server/src/__tests__/rt2-daily-report-routes.test.ts server/src/__tests__/rt2-task-routes.test.ts packages/shared/src/rt2-daily-report.test.ts` [VERIFIED: files exist]
- **Phase gate:** `pnpm typecheck` plus focused Vitest evidence; run `pnpm test` if feasible. [VERIFIED: AGENTS.md; .planning/phases/50-work-card-editing-and-board-controls/50-CONTEXT.md]

### Wave 0 Gaps

- [ ] `packages/shared/src/rt2-daily-report.test.ts` - add tests for enriched daily card fields and validator exports for new edit payloads. [VERIFIED: file exists]
- [ ] `server/src/__tests__/rt2-daily-report-routes.test.ts` - add route tests for cohesive payload fields, daily lane wiki preservation after Phase 50 changes, and approval/quality proxy semantics. [VERIFIED: file exists]
- [ ] `server/src/__tests__/rt2-task-routes.test.ts` - add or extend tests for reused work-board quality metadata and deliverable/base-price conventions if endpoints remain there. [VERIFIED: file exists]
- [ ] `ui/src/components/Rt2DailyBoard.test.tsx` - add tests for quick edit affordance, Korean per-field save/failure feedback, five filters, search targets, and non-persisted sort order. [VERIFIED: file exists]

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | yes | Existing routes require `req.actor.type === "board"` for board-user mutations. [VERIFIED: server/src/routes/rt2-daily-report.ts; server/src/routes/rt2-tasks.ts] |
| V3 Session Management | no direct change | Use existing API client/session behavior; Phase 50 does not define sessions. [VERIFIED: phase scope] |
| V4 Access Control | yes | `assertCompanyAccess` and actor/user ownership checks guard daily and work-board routes. [VERIFIED: server/src/routes/rt2-daily-report.ts; server/src/routes/rt2-tasks.ts; server/src/services/rt2-daily-report.ts] |
| V5 Input Validation | yes | Shared Zod validators for all new payloads. [VERIFIED: packages/shared/src/validators/rt2-daily-report.ts; packages/shared/src/validators/rt2-task.ts] |
| V6 Cryptography | no direct change | Phase 50 does not add crypto; do not hand-roll signing/secrets. [VERIFIED: phase scope] |

### Known Threat Patterns for Phase 50

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Cross-company card mutation | Tampering | Keep `assertCompanyAccess` and service-level company checks on every update path. [VERIFIED: server/src/routes/rt2-daily-report.ts; server/src/services/rt2-work-board.ts] |
| Editing another user's daily card | Elevation of Privilege | Preserve `todo.assigneeUserId === actorUserId` check for daily card saves. [VERIFIED: server/src/services/rt2-daily-report.ts] |
| Invalid enum/string payloads | Tampering | Validate through shared Zod schemas and route `validate(...)`. [VERIFIED: server/src/routes/rt2-daily-report.ts; server/src/routes/rt2-tasks.ts] |
| XSS through title/note/search text | Information Disclosure/Tampering | React escapes text by default; keep rendering as text, not raw HTML. [ASSUMED] |

## Sources

### Primary (HIGH confidence)
- `.planning/phases/50-work-card-editing-and-board-controls/50-CONTEXT.md` - locked Phase 50 decisions and deferred scope. [VERIFIED: file read]
- `.planning/REQUIREMENTS.md` - BOARD-04 and BOARD-05. [VERIFIED: file read]
- `.planning/ROADMAP.md` - Phase 50 goal and success criteria. [VERIFIED: file read]
- `.planning/STATE.md` - Phase 49 complete, Phase 50 ready, Windows embedded Postgres/full test debt. [VERIFIED: file read]
- `.planning/phases/49-daily-work-kanban-core/49-CONTEXT.md` - upstream daily board/lane decisions. [VERIFIED: file read]
- `AGENTS.md` - Korean-first communication, command, and workflow constraints. [VERIFIED: file read]
- `ui/src/components/Rt2DailyBoard.tsx` - current board UI, drafts, lane grouping, save feedback. [VERIFIED: file read]
- `packages/shared/src/types/rt2-daily-report.ts` and `packages/shared/src/validators/rt2-daily-report.ts` - daily board contract. [VERIFIED: file read]
- `server/src/routes/rt2-daily-report.ts` and `server/src/services/rt2-daily-report.ts` - daily board route/service behavior. [VERIFIED: file read]
- `packages/shared/src/types/rt2-task.ts`, `packages/shared/src/validators/rt2-task.ts`, `server/src/routes/rt2-tasks.ts`, `server/src/services/rt2-work-board.ts`, `packages/db/src/schema/rt2_work_board.ts` - work-board metadata behavior. [VERIFIED: file read]
- `server/src/routes/issues.ts`, `packages/shared/src/validators/issue.ts`, `server/src/services/issues.ts` - issue title/goal update route pattern. [VERIFIED: file read]
- `server/src/__tests__/rt2-daily-report-routes.test.ts`, `server/src/__tests__/rt2-task-routes.test.ts`, `ui/src/components/Rt2DailyBoard.test.tsx` - focused test paths. [VERIFIED: file read]

### Secondary (MEDIUM confidence)
- npm registry checks for `react`, `@tanstack/react-query`, `zod`, and `vitest` latest versions and modified dates. [VERIFIED: npm registry]

### Tertiary (LOW confidence)
- None. [VERIFIED: research log]

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - derived from repo package manifests and npm registry version checks. [VERIFIED: package.json; ui/package.json; server/package.json; npm registry]
- Architecture: HIGH - core ownership follows existing route/service/schema contracts. [VERIFIED: codebase grep]
- Pitfalls: HIGH for lane/base-price/OKR/payload risks, MEDIUM for approval-waiting semantics because no single daily-card approval field exists. [VERIFIED: codebase grep]

**Research date:** 2026-04-30 [VERIFIED: current_date]
**Valid until:** 2026-05-07 for npm/library currency and until next daily-board contract change for code ownership. [ASSUMED]
