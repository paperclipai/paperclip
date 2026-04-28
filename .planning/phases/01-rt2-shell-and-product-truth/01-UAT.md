# Phase 1 UAT - RT2 Shell and Product Truth

## UAT Checks

### UAT-1: RT2 is the default company landing
- [x] Visiting a company-scoped board route lands on `/:companyPrefix/one-liner` instead of `/:companyPrefix/dashboard`
- [x] The landing page reads as an RT2 entry point, not a Paperclip dashboard

### UAT-2: Primary navigation is RT2-first
- [x] Desktop primary nav exposes `One-Liner`, `Knowledge`, `Marketplace`, `P&L`, `Org`, and `Governance`
- [x] Mobile primary nav exposes the same RT2-first route set or a truthful reduced equivalent
- [x] Dashboard, Inbox, Issues, Projects, Agents, Goals, Routines, Costs, Activity, Skills, and Settings are no longer the primary nav block

### UAT-3: One-Liner reuses the existing RT2 capture flow
- [x] The One-Liner route can launch the existing RT2 creation dialog
- [x] The launch path uses RT2 task/todo defaults instead of a generic Paperclip issue flow
- [x] Deliverable-aware capture is visible from the first RT2 landing path

### UAT-4: Knowledge is a top-level RT2 route
- [x] A company-level `Knowledge` page exists
- [x] `Knowledge` exposes daily, wiki, and graph subviews from one route family
- [x] Knowledge can be reached without entering `ProjectDetail`

### UAT-5: Marketplace and P&L are first-class RT2 routes
- [x] `Marketplace` exists as a top-level company route
- [x] `P&L` exists as a top-level company route
- [x] If either page is still shallow, it renders a truthful partial or empty state rather than fake data

### UAT-6: Org and Governance are first-class RT2 routes
- [x] `Org` is reachable from the primary RT2 nav
- [x] `Governance` is reachable from the primary RT2 nav
- [x] Both routes preserve company scope

### UAT-7: Paperclip views remain reachable through a secondary path
- [x] A secondary control-plane entry exists inside the company shell
- [x] That path links to legacy Paperclip views without losing company context
- [x] Operators can move from RT2 routes into Dashboard or Issues and remain inside the selected company

### UAT-8: Developer and stub-only routes are no longer first-class
- [x] `design-guide` does not appear in the operator primary nav
- [x] `tests/ux/chat` and `tests/ux/runs` do not appear in the operator primary nav
- [x] Collaboration and quality are not promoted to top-level RT2 routes while they still depend on stub fallback data

### UAT-9: Verification
- [x] `pnpm -r typecheck` passes
- [x] `pnpm test:run` passes
- [x] `pnpm build` passes
