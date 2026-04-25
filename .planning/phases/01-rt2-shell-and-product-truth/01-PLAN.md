# Phase 1: RT2 Shell and Product Truth

**Phase:** 1
**Status:** Executed pending verification
**Created:** 2026-04-24
**Requirements:** IDENT-01, IDENT-02

## Goal

Make RT2 the first-class product shell at company scope by moving the default landing, primary navigation, and top-level route taxonomy away from Paperclip-first screens while preserving safe access to underlying control-plane views.

---

## Wave 1: Route Contract and Primary Shell

### PLAN-01: Company Route Contract

**Objective:** Rewire company-scoped routing so RT2 pages are the canonical landing and top-level route family.

**Files Modified:**
- `ui/src/App.tsx`
- `ui/src/lib/company-routes.ts`

**Tasks:**

```yaml
- id: route-contract
  objective: Add first-class company-scoped RT2 routes
  depends_on: []
  files_modified:
    - ui/src/App.tsx
    - ui/src/lib/company-routes.ts
  read_first:
    - ui/src/App.tsx
    - ui/src/lib/company-routes.ts
    - .planning/phases/01-rt2-shell-and-product-truth/01-CONTEXT.md
  action: |
    Update the company-scoped route model so:
    - the default company landing redirects to `/:companyPrefix/one-liner`
    - company-scoped routes exist for `one-liner`, `knowledge`, `marketplace`, `pnl`, `org`, and `governance`
    - company route helpers expose those canonical RT2 destinations
    - unprefixed redirects continue to preserve selected company context instead of introducing a second route model
  acceptance_criteria:
    - "grep -n 'path=\"one-liner\"' ui/src/App.tsx returns a company-scoped route"
    - "grep -n 'path=\"knowledge\"' ui/src/App.tsx returns a company-scoped route"
    - "grep -n 'path=\"marketplace\"' ui/src/App.tsx returns a company-scoped route"
    - "grep -n 'path=\"pnl\"' ui/src/App.tsx returns a company-scoped route"
    - "grep -n 'path=\"governance\"' ui/src/App.tsx returns a company-scoped route"
    - "grep -n 'one-liner' ui/src/lib/company-routes.ts returns an RT2 route helper"
```

---

### PLAN-02: Primary Navigation Taxonomy

**Objective:** Replace the Paperclip-first primary nav with RT2-first navigation on desktop and mobile.

**Files Modified:**
- `ui/src/components/Sidebar.tsx`
- `ui/src/components/MobileBottomNav.tsx`
- `ui/src/components/Layout.tsx`

**Tasks:**

```yaml
- id: primary-nav
  objective: Promote RT2 routes to primary navigation
  depends_on: [route-contract]
  files_modified:
    - ui/src/components/Sidebar.tsx
    - ui/src/components/MobileBottomNav.tsx
    - ui/src/components/Layout.tsx
  read_first:
    - ui/src/components/Sidebar.tsx
    - ui/src/components/MobileBottomNav.tsx
    - ui/src/components/Layout.tsx
    - .planning/phases/01-rt2-shell-and-product-truth/01-CONTEXT.md
  action: |
    Rebuild primary nav so the first-class operator routes are:
    - One-Liner
    - Knowledge
    - Marketplace
    - P&L
    - Org
    - Governance
    Keep company context visible in the shell and move Paperclip views behind a secondary control-plane entry instead of the primary nav set.
  acceptance_criteria:
    - "grep -n 'One-Liner' ui/src/components/Sidebar.tsx returns a nav item"
    - "grep -n 'Knowledge' ui/src/components/Sidebar.tsx returns a nav item"
    - "grep -n 'Marketplace' ui/src/components/Sidebar.tsx returns a nav item"
    - "grep -n 'P&L' ui/src/components/Sidebar.tsx returns a nav item"
    - "grep -n 'Governance' ui/src/components/Sidebar.tsx returns a nav item"
    - "grep -n 'One-Liner' ui/src/components/MobileBottomNav.tsx returns a mobile nav item or action"
```

---

## Wave 2: First-Class RT2 Pages

### PLAN-03: One-Liner Landing Page

**Objective:** Create an RT2 landing page that reuses the existing deliverable-aware creation flow instead of inventing a parallel input stack.

**Files Modified:**
- `ui/src/pages/rt2/OneLinerPage.tsx` (new)
- `ui/src/context/DialogContext.tsx`
- `ui/src/components/NewIssueDialog.tsx`

**Tasks:**

```yaml
- id: one-liner-page
  objective: Create first-pass One-Liner page on top of existing RT2 capture flow
  depends_on: [route-contract]
  files_modified:
    - ui/src/pages/rt2/OneLinerPage.tsx
    - ui/src/context/DialogContext.tsx
    - ui/src/components/NewIssueDialog.tsx
  read_first:
    - ui/src/context/DialogContext.tsx
    - ui/src/components/NewIssueDialog.tsx
    - ui/src/pages/ProjectDetail.tsx
    - .planning/phases/01-rt2-shell-and-product-truth/01-CONTEXT.md
  action: |
    Create a company-level One-Liner page that:
    - acts as the default RT2 landing page
    - launches the existing RT2 task/todo capture dialog through DialogContext
    - exposes deliverable-aware defaults instead of a generic Paperclip issue flow
    - uses truthful copy that richer freeform parsing belongs to Phase 2
    Keep the implementation on top of the existing `openNewIssue()` contract rather than creating a second form or API path.
  acceptance_criteria:
    - "grep -n 'function OneLinerPage\\|const OneLinerPage' ui/src/pages/rt2/OneLinerPage.tsx returns the page component"
    - "grep -n 'openNewIssue' ui/src/pages/rt2/OneLinerPage.tsx returns the existing dialog launcher"
    - "grep -n 'deliverable' ui/src/pages/rt2/OneLinerPage.tsx returns deliverable-oriented UI copy or defaults"
```

---

### PLAN-04: Knowledge Page

**Objective:** Promote daily/wiki/graph into one coherent RT2 route instead of leaving them only inside project tabs.

**Files Modified:**
- `ui/src/pages/rt2/KnowledgePage.tsx` (new)
- `ui/src/components/Rt2DailyBoard.tsx`
- `ui/src/components/Rt2DailyWikiPanel.tsx`
- `ui/src/components/Rt2GraphPanel.tsx`

**Tasks:**

```yaml
- id: knowledge-page
  objective: Build a consolidated Knowledge route
  depends_on: [route-contract]
  files_modified:
    - ui/src/pages/rt2/KnowledgePage.tsx
    - ui/src/components/Rt2DailyBoard.tsx
    - ui/src/components/Rt2DailyWikiPanel.tsx
    - ui/src/components/Rt2GraphPanel.tsx
  read_first:
    - ui/src/components/Rt2DailyBoard.tsx
    - ui/src/components/Rt2DailyWikiPanel.tsx
    - ui/src/components/Rt2GraphPanel.tsx
    - ui/src/pages/ProjectDetail.tsx
    - .planning/phases/01-rt2-shell-and-product-truth/01-CONTEXT.md
  action: |
    Create a company-level Knowledge page that:
    - exposes daily, wiki, and graph as internal subviews or tabs
    - reuses existing RT2 panels where possible
    - does not require entry through a project detail page
    - preserves project drill-down links where they already exist
  acceptance_criteria:
    - "grep -n 'function KnowledgePage\\|const KnowledgePage' ui/src/pages/rt2/KnowledgePage.tsx returns the page component"
    - "grep -n 'Daily\\|Wiki\\|Graph' ui/src/pages/rt2/KnowledgePage.tsx returns the internal knowledge subviews"
    - "grep -n 'Rt2DailyWikiPanel' ui/src/pages/rt2/KnowledgePage.tsx returns reuse of an existing RT2 panel"
    - "grep -n 'Rt2GraphPanel' ui/src/pages/rt2/KnowledgePage.tsx returns reuse of an existing RT2 panel"
```

---

### PLAN-05: Marketplace, P&L, Governance, and Org Pages

**Objective:** Promote truthful RT2 company pages for the remaining Phase 1 top-level routes.

**Files Modified:**
- `ui/src/pages/rt2/MarketplacePage.tsx` (new)
- `ui/src/pages/rt2/PnlPage.tsx` (new)
- `ui/src/pages/rt2/GovernancePage.tsx` (new)
- `ui/src/pages/OrgChart.tsx`
- `ui/src/api/rt2-marketplace.ts` (new if needed)
- `ui/src/api/rt2-pnl.ts` (new if needed)

**Tasks:**

```yaml
- id: rt2-top-level-pages
  objective: Create or wrap company-level pages for Marketplace, P&L, Governance, and Org
  depends_on: [route-contract]
  files_modified:
    - ui/src/pages/rt2/MarketplacePage.tsx
    - ui/src/pages/rt2/PnlPage.tsx
    - ui/src/pages/rt2/GovernancePage.tsx
    - ui/src/pages/OrgChart.tsx
    - ui/src/api/rt2-marketplace.ts
    - ui/src/api/rt2-pnl.ts
  read_first:
    - ui/src/components/Rt2GovernancePanel.tsx
    - ui/src/pages/OrgChart.tsx
    - server/src/routes/rt2-agent-marketplace.ts
    - server/src/routes/rt2-personal-pnl.ts
    - server/src/routes/rt2-governance.ts
    - .planning/phases/01-rt2-shell-and-product-truth/01-CONTEXT.md
  action: |
    Add company-level RT2 pages so:
    - Governance wraps the existing governance surface
    - Org uses the existing org chart path as a first-class RT2 route
    - Marketplace and P&L are visible top-level routes backed by existing server endpoints where possible
    - if Marketplace or P&L are still shallow, they render truthful empty or partial states rather than fake data
  acceptance_criteria:
    - "grep -n 'function MarketplacePage\\|const MarketplacePage' ui/src/pages/rt2/MarketplacePage.tsx returns the page component"
    - "grep -n 'function PnlPage\\|const PnlPage' ui/src/pages/rt2/PnlPage.tsx returns the page component"
    - "grep -n 'function GovernancePage\\|const GovernancePage' ui/src/pages/rt2/GovernancePage.tsx returns the page component"
    - "grep -n 'Rt2GovernancePanel' ui/src/pages/rt2/GovernancePage.tsx returns reuse of the existing governance surface"
```

---

## Wave 3: Secondary Paperclip Access and Cleanup

### PLAN-06: Secondary Control-Plane Path

**Objective:** Keep underlying Paperclip views reachable without allowing them to define the primary shell.

**Files Modified:**
- `ui/src/pages/ControlPlanePage.tsx` (new)
- `ui/src/components/Sidebar.tsx`
- `ui/src/lib/company-routes.ts`

**Tasks:**

```yaml
- id: control-plane-path
  objective: Add a company-preserving secondary Paperclip access path
  depends_on: [primary-nav]
  files_modified:
    - ui/src/pages/ControlPlanePage.tsx
    - ui/src/components/Sidebar.tsx
    - ui/src/lib/company-routes.ts
  read_first:
    - ui/src/components/Sidebar.tsx
    - ui/src/lib/company-routes.ts
    - ui/src/App.tsx
    - .planning/phases/01-rt2-shell-and-product-truth/01-CONTEXT.md
  action: |
    Add a secondary control-plane entry that links to existing company-scoped Paperclip views:
    - Dashboard
    - Inbox
    - Issues
    - Projects
    - Agents
    - Goals
    - Routines
    - Costs
    - Activity
    - Skills
    - Settings
    Keep existing routes intact and preserve company prefix on every link.
  acceptance_criteria:
    - "grep -n 'path=\"control-plane\"' ui/src/App.tsx returns the secondary entry route"
    - "grep -n 'Dashboard' ui/src/pages/ControlPlanePage.tsx returns a company-preserving link"
    - "grep -n 'Inbox' ui/src/pages/ControlPlanePage.tsx returns a company-preserving link"
    - "grep -n 'Projects' ui/src/pages/ControlPlanePage.tsx returns a company-preserving link"
```

---

### PLAN-07: Hide Lab-Only Surfaces from the Primary Operator Path

**Objective:** Remove developer and stub-only routes from the primary RT2 shell without deleting their code.

**Files Modified:**
- `ui/src/components/Sidebar.tsx`
- `ui/src/components/MobileBottomNav.tsx`
- `ui/src/App.tsx`

**Tasks:**

```yaml
- id: hide-lab-routes
  objective: Keep developer utilities and stub-heavy surfaces out of the primary RT2 shell
  depends_on: [primary-nav]
  files_modified:
    - ui/src/components/Sidebar.tsx
    - ui/src/components/MobileBottomNav.tsx
    - ui/src/App.tsx
  read_first:
    - ui/src/components/Sidebar.tsx
    - ui/src/components/MobileBottomNav.tsx
    - ui/src/App.tsx
    - ui/src/components/Rt2CollaborationPanel.tsx
    - ui/src/components/Rt2QualityPanel.tsx
    - .planning/phases/01-rt2-shell-and-product-truth/01-CONTEXT.md
  action: |
    Remove `design-guide` and `tests/ux/*` from the primary navigation.
    Keep collaboration, rewards, and quality out of the new top-level RT2 route set while their implementations remain stub-backed or project-scoped.
    Direct URLs may remain available for developers if they are not linked as first-class operator paths.
  acceptance_criteria:
    - "rg -n 'design-guide' ui/src/components/Sidebar.tsx ui/src/components/MobileBottomNav.tsx returns no primary nav link"
    - "rg -n 'tests/ux/chat|tests/ux/runs' ui/src/components/Sidebar.tsx ui/src/components/MobileBottomNav.tsx returns no primary nav link"
```

---

## Wave 4: Verification

### PLAN-08: Verification and Regression Check

**Objective:** Verify the RT2 shell refactor without breaking company-scoped board routing.

**Tasks:**

```yaml
- id: verify-typecheck
  objective: Run monorepo typecheck
  depends_on: [one-liner-page, knowledge-page, rt2-top-level-pages, control-plane-path, hide-lab-routes]
  command: pnpm -r typecheck
  acceptance_criteria:
    - "pnpm -r typecheck exits 0"

- id: verify-tests
  objective: Run default test suite
  depends_on: [verify-typecheck]
  command: pnpm test:run
  acceptance_criteria:
    - "pnpm test:run exits 0"

- id: verify-build
  objective: Build the app
  depends_on: [verify-tests]
  command: pnpm build
  acceptance_criteria:
    - "pnpm build exits 0"
```

---

## Dependency Order

```text
Wave 1:
  PLAN-01 Route Contract -> PLAN-02 Primary Navigation

Wave 2:
  PLAN-01 -> PLAN-03 One-Liner
  PLAN-01 -> PLAN-04 Knowledge
  PLAN-01 -> PLAN-05 Marketplace/P&L/Governance/Org

Wave 3:
  PLAN-02 -> PLAN-06 Secondary Control Plane
  PLAN-02 -> PLAN-07 Hide Lab Routes

Wave 4:
  PLAN-03 + PLAN-04 + PLAN-05 + PLAN-06 + PLAN-07 -> PLAN-08 Verification
```

---

## Existing Reference Assets

| File | Why it matters |
|------|----------------|
| `ui/src/App.tsx` | Current route table and default company redirect |
| `ui/src/components/Sidebar.tsx` | Current primary navigation model |
| `ui/src/components/MobileBottomNav.tsx` | Current mobile route taxonomy |
| `ui/src/components/NewIssueDialog.tsx` | Existing RT2-aware capture flow for One-Liner |
| `ui/src/context/DialogContext.tsx` | Shell-level action launcher pattern |
| `ui/src/components/Rt2GovernancePanel.tsx` | Existing governance surface to wrap |
| `ui/src/components/Rt2DailyWikiPanel.tsx` | Existing knowledge surface for wiki |
| `ui/src/components/Rt2GraphPanel.tsx` | Existing knowledge surface for graph |
| `ui/src/pages/ProjectDetail.tsx` | Current project-scoped RT2 tab host |
