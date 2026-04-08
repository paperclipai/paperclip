# 2026-04-08 Sprint 2 — UI + Org Chart + Tests

Status: Ready
Date: 2026-04-08
Audience: Product and engineering
Related:
- `doc/plans/2026-04-08-phase1-implementation-plan.md`
- `doc/plans/2026-04-08-paperclip-capability-audit.md`
- `doc/spec/ui.md`

## 1. Goal

Finish the operator-facing surface for Phase 1 organizational structure work.

Sprint 2 should not re-open schema or core modeling debates.
It should take the existing departments and teams foundation and turn it into:

- a discoverable UI
- a non-broken navigation flow
- an org chart mode that reflects departments
- a test-backed slice that is safe to merge

## 2. Current Snapshot

Sprint 1 groundwork is largely present in the repo already.

### 2.1 Already implemented

- department schema, memberships, and routes exist
- team schema and routes exist
- `department_id` exists on `agents`, `projects`, and `issues`
- `ui/src/api/departments.ts` exists
- `queryKeys.departments` and `queryKeys.teams` exist
- `ui/src/pages/Departments.tsx` exists
- `ui/src/pages/DepartmentDetail.tsx` exists
- app routes for `/departments` and `/departments/:departmentId` already exist

### 2.2 Partially implemented

- departments UI works as a basic CRUD surface, but it is not yet fully integrated into navigation and broader company UX
- the departments list page shows teams, but team detail navigation is not wired in app routes yet
- the detail page supports editing and membership operations, but uses raw principal ID entry instead of operator-friendly selection

### 2.3 Not implemented

- sidebar discoverability for departments
- org chart grouping by department
- server tests for departments and teams
- UI tests for departments surfaces
- a coherent end-to-end validation story for the new org structure UX

## 3. Recommended Sprint Framing

Yes, Sprint 2 should continue.

But it should be framed as a completion sprint, not a greenfield sprint.

The correct objective is:

1. finish the UI integration gaps already exposed by the current code
2. add the least risky department-aware org chart mode
3. add tests that lock the work in

This is a better use of time than starting another model-layer expansion immediately.

## 4. Scope for Sprint 2

## 4.1 In scope

- departments discoverability in the operator UI
- department detail UX hardening
- team navigation cleanup
- department-aware org chart mode
- server tests for department/team behavior
- UI tests for department pages and org chart mode

## 4.2 Explicitly out of scope

- department-scoped permissions or visibility enforcement
- drag-and-drop department editing
- full reporting by department
- SLA logic
- budget policies by department
- major org chart renderer refactor

## 5. Current Gaps to Close

The current repo already reveals the highest-priority Sprint 2 gaps:

1. Departments are routed but not visible in the main sidebar.
2. Teams are linked from the departments page but there is no routed team detail page yet.
3. Department detail uses manual principal ID entry, which is functional but not operator-friendly.
4. The org chart still models reporting only, not department grouping.
5. Tests for the new organizational surface are absent.

## 6. Execution Plan

## 6.1 Workstream A — Close navigation and route gaps

Goal:

- make the new feature discoverable
- remove broken links
- keep the company UX coherent

Files:

- `ui/src/components/Sidebar.tsx`
- `ui/src/App.tsx`
- `ui/src/pages/Departments.tsx`
- `ui/src/pages/DepartmentDetail.tsx`
- `ui/src/pages/TeamDetail.tsx` (new) or remove team link temporarily

Tasks:

1. Add `Departments` to the `Company` section in the main sidebar.
2. Decide whether teams are in Sprint 2 MVP:
   - preferred: add a minimal `TeamDetail` page and route
   - fallback: remove team links from `Departments.tsx` until team UI is ready
3. Confirm route behavior under company-prefixed paths remains correct.
4. Confirm breadcrumbs are correct for list and detail pages.
5. Add clear empty and error states where missing.

Acceptance criteria:

- a board operator can discover departments from the sidebar
- no UI link leads to a 404
- departments list and detail pages work under normal company routing

## 6.2 Workstream B — Harden departments UI

Goal:

- move the departments surface from "bare CRUD" to "usable operator feature"

Files:

- `ui/src/pages/Departments.tsx`
- `ui/src/pages/DepartmentDetail.tsx`
- `ui/src/api/departments.ts`
- optional extraction files:
  - `ui/src/components/DepartmentTree.tsx`
  - `ui/src/components/NewDepartmentDialog.tsx`
  - `ui/src/components/DepartmentMemberDialog.tsx`

Tasks:

1. Extract large inline UI pieces from `Departments.tsx` and `DepartmentDetail.tsx` into reusable components if that reduces page complexity materially.
2. Replace raw principal ID entry with an operator-friendly selector:
   - load agents for the selected company
   - load users/memberships if available through existing company access APIs
   - show label + ID rather than forcing manual copy/paste
3. Show parent department context on the detail page if `parentId` exists.
4. Show child departments on the detail page using the existing department tree/list data.
5. Keep related-entity panels lightweight for this sprint:
   - if filtered issue/agent/project APIs do not exist, do not invent heavy server work here
   - prefer summary counts or deferred follow-up over scope creep
6. Standardize archive UX with a proper confirmation dialog rather than raw `confirm()` if feasible inside sprint time.

Acceptance criteria:

- a user can create, edit, archive, and manage members without memorizing IDs
- parent/child department relationships are visible in the UI
- the detail page feels intentionally integrated, not like an admin stub

## 6.3 Workstream C — Department-aware org chart

Goal:

- reflect the new organizational model without destabilizing the current chart renderer

Important constraint:

- do not try to refactor the entire org chart into a mixed graph renderer this sprint

Recommended design:

1. Keep the existing reporting-tree renderer intact.
2. Add a second org chart mode: `Grouped by department`.
3. In department mode, render department sections around the existing reporting trees instead of inventing a new recursive node type for the whole chart.

Recommended API shape:

- extend `GET /companies/:companyId/org` with `?groupBy=department`
- return grouped sections such as:

```ts
type DepartmentOrgGroup = {
  department: {
    id: string;
    name: string;
  } | null;
  memberCount: number;
  roots: OrgNode[];
};
```

Why this is safer than injecting department nodes into the core tree:

- the current `OrgChart.tsx` layout is built around agent reporting recursion
- the SVG renderer is already large and should not be deeply refactored in Phase 1
- grouped sections let us reuse the current layout logic with lower regression risk

Files:

- `server/src/routes/agents.ts`
- `server/src/routes/org-chart-svg.ts` only if export behavior is included in Sprint 2
- `server/src/services/agents.ts` or the org-building service path
- `ui/src/api/agents.ts`
- `ui/src/pages/OrgChart.tsx`

Tasks:

1. Add grouped-org response support on the backend behind a query parameter.
2. Preserve current default response shape for backwards compatibility.
3. Add a small mode switch in the UI:
   - `Reporting hierarchy`
   - `Grouped by department`
4. In grouped mode, render department cards/headers with member count and then render one or more existing trees per section.
5. Keep "Unassigned" or "No department" as a valid bucket for agents without `department_id`.
6. If export support is too expensive, defer grouped SVG/PNG export to a follow-up and keep the UI mode first.

Acceptance criteria:

- the org chart can be viewed by reporting hierarchy or by department grouping
- grouped mode works for mixed data, including agents with no department
- default org chart behavior does not regress

## 6.4 Workstream D — Server test coverage

Goal:

- lock in the new organizational behavior at the route/service level

Files:

- `server/src/__tests__/departments.test.ts`
- `server/src/__tests__/teams.test.ts`
- optional:
  - `server/src/__tests__/org-grouping.test.ts`

Departments test matrix:

- create department
- duplicate department name rejected
- update department
- archive department
- create nested department
- self-parent rejected
- circular parent chain rejected
- parent from another company rejected
- add user member
- add agent member
- duplicate membership rejected
- remove member
- tree endpoint returns nested structure
- tree endpoint includes member counts

Teams test matrix:

- create team
- duplicate team name rejected
- team with valid department
- team with cross-company department rejected
- add/remove members

Org grouping tests:

- default `/org` shape unchanged
- `/org?groupBy=department` returns grouped structure
- unassigned agents fall into null or "unassigned" bucket

## 6.5 Workstream E — UI tests

Goal:

- verify the operator workflows, not just render snapshots

Files:

- `ui/src/pages/Departments.test.tsx`
- `ui/src/pages/DepartmentDetail.test.tsx`
- `ui/src/pages/OrgChart.test.tsx` or a narrower component-level test file
- optional:
  - `ui/src/components/DepartmentTree.test.tsx`

UI test matrix:

- departments page shows empty state
- departments page renders nested tree
- create department dialog submits and refreshes list
- sidebar renders departments nav item
- department detail loads and displays members
- add member flow works
- remove member flow works
- archive action redirects back to list
- org chart mode toggle changes between normal and grouped department views
- team links do not lead to dead routes

Test style guidance:

- prefer behavior-driven tests around page interaction
- avoid brittle pixel assertions for org chart rendering
- mock API responses at the page boundary

## 7. Delivery Order

The safest order is:

1. Navigation and broken-link cleanup
2. Department detail UX hardening
3. Backend grouped-org API
4. Org chart grouped mode UI
5. Server tests
6. UI tests
7. Full repo verification

Why this order:

- it closes visible rough edges immediately
- it reduces the chance of building tests against unstable UI flows
- it keeps the org chart work isolated until the surrounding UX is settled

## 8. Suggested Cut Line

If time gets tight, keep this as the Sprint 2 must-ship line:

1. sidebar integration
2. no broken team navigation
3. better member picker UX
4. grouped department org chart mode in the browser UI
5. server tests for departments and teams
6. at least one UI test for departments list and one for department detail

These can be deferred if necessary:

- grouped SVG/PNG export
- richer team detail UX
- related issues/agents/projects tabs with full filtering support
- UI component extraction for cleanliness only

## 9. Verification

Before Sprint 2 is called complete, run:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

If grouped org chart export is included, also manually verify:

1. `/org` default mode
2. grouped department mode in the browser
3. at least one company with:
   - nested departments
   - agents without department
   - multiple reporting roots

## 10. Definition of Done for Sprint 2

Sprint 2 is done when all are true:

1. Departments are discoverable from the main UI.
2. The department UI has no dead-end or broken team navigation.
3. Department membership management is operator-friendly.
4. Org chart supports a department-aware view without regressing the default reporting tree.
5. Server tests cover the new department and team behaviors.
6. UI tests cover the main department workflows.
7. Full repo verification passes.

## 11. Bottom Line

Sprint 2 should continue.

But the right framing is not "build UI from scratch".
It is:

- finish the new organizational UX
- integrate it into the chart and navigation
- prove it with tests

That is the fastest path to turning the current Phase 1 work into something stable and reviewable.
