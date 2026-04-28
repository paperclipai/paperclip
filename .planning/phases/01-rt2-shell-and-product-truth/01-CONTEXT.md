# Phase 1: RT2 Shell and Product Truth - Context

**Gathered:** 2026-04-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Reframe the app so RealTycoon 2 is the default operator experience at company scope. This phase decides the shell, route model, navigation taxonomy, and Paperclip boundary. It does not yet implement freeform One-Liner parsing, CQRS/event streaming, Multica runtime integration, or data-backed Jarvis/collaboration/quality systems.

</domain>

<decisions>
## Implementation Decisions

### Landing and route model
- **D-01:** The default company landing route moves from `/:companyPrefix/dashboard` to `/:companyPrefix/one-liner`.
- **D-02:** Phase 1 first-class RT2 routes are `one-liner`, `knowledge`, `marketplace`, `pnl`, `org`, and `governance`.
- **D-03:** Company-prefixed URLs remain canonical for RT2 routes. Unprefixed redirects continue to resolve through the selected company instead of creating a second route model.

### Knowledge composition
- **D-04:** `Knowledge` becomes a single company-level route that consolidates daily, wiki, and graph views behind internal subviews.
- **D-05:** Existing project-level RT2 tabs for daily/wiki/graph remain as contextual drill-downs, but they are no longer the primary IA for reaching those capabilities.

### Paperclip boundary
- **D-06:** Existing Paperclip views stay available as a secondary control-plane path rather than the primary RT2 navigation.
- **D-07:** Phase 1 keeps company context intact when operators move from RT2 primary routes into Dashboard, Inbox, Issues, Projects, Agents, Goals, Routines, Costs, Activity, Skills, and Settings.
- **D-08:** Phase 1 does not promote routes whose company access posture is incomplete. Existing access-check TODOs remain blockers for later promotion, not reasons to relax company-scoped routing.

### Promotion and hiding
- **D-09:** `tests/ux/*` and `design-guide` are removed from the primary operator path and treated as developer utilities.
- **D-10:** Stub-heavy collaboration, rewards, and quality surfaces stay inside project context in Phase 1. They do not become first-class RT2 navigation until backed by real data.
- **D-11:** Marketplace and P&L must become first-class routes in Phase 1 even if their first version is a thin page over existing APIs or a truthful empty state.

### One-Liner reuse strategy
- **D-12:** Phase 1 reuses the existing `NewIssueDialog` plus `DialogContext` RT2 task/todo capture flow as the first One-Liner entry point instead of inventing a second creation stack.
- **D-13:** The shell should expose deliverable-aware capture immediately through the existing RT2 defaults (`rt2Mode`, `rt2TaskMode`, `capacity`, `deliverableTitle`) and defer richer freeform drafting to Phase 2.

### Reconstruction policy
- **D-14:** Phase 1 and Phase 2 follow a reconstruction-first policy: prefer new company-level RT2 pages and route contracts over continued patching of legacy Paperclip-first screens.
- **D-15:** Stable company-scoped backend/domain assets should be reused, but nested RT2 project-tab UI and placeholder surfaces are migration inputs, not protected product surfaces.

### the agent's Discretion
- Exact RT2 page layout and visual hierarchy inside each new top-level page
- The label and presentation style of the secondary Paperclip/control-plane entry
- Mobile overflow behavior for lower-priority nav items
- Whether the initial One-Liner page uses an inline launcher, a page-level CTA, or both, as long as it reuses the same capture contract

</decisions>

<specifics>
## Specific Ideas

- The shell should feel like RealTycoon 2, not Paperclip with extra tabs.
- Brownfield reuse should be selective, not sentimental. Keep stable domain/backend assets, but rebuild product-facing RT2 surfaces when retrofit cost is higher than replacement cost.
- Marketplace and P&L are allowed to ship first as truthful shells if the underlying domain behavior is still shallow, but they must exist as first-class routes.
- Stub-only panels should not be promoted just to satisfy the route checklist.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Milestone source of truth
- `.planning/PROJECT.md` — Milestone framing and corrected product identity for RT2 v2.0
- `.planning/REQUIREMENTS.md` — Requirement IDs, especially `IDENT-01` and `IDENT-02`
- `.planning/ROADMAP.md` — Phase 1 goal, success criteria, and milestone order
- `.planning/STATE.md` — Current milestone state and active focus
- `.tmp/RealTycoon2_DevPlan_2_clean.txt` — Workspace copy of the extracted RT2 development plan text used to restate the product target

### Product and repo constraints
- `AGENTS.md` — Repo contract, company-scope rules, synchronized contract expectations, and verification requirements
- `doc/PRODUCT.md` — Current Paperclip product framing that Phase 1 must stop exposing as the primary shell
- `doc/SPEC-implementation.md` — Existing V1 control-plane behavior that remains the safety boundary underneath RT2

### Current shell and routing code
- `ui/src/App.tsx` — Current board route table, default company landing, and unprefixed redirect behavior
- `ui/src/components/Layout.tsx` — Shared board shell and company-scoped layout composition
- `ui/src/components/Sidebar.tsx` — Current Paperclip-first primary navigation
- `ui/src/components/MobileBottomNav.tsx` — Current mobile-first primary navigation
- `ui/src/components/CompanyRail.tsx` — Company-scoped shell chrome that must remain coherent after IA changes
- `ui/src/lib/company-routes.ts` — Canonical helper for company-prefixed routing

### Reusable RT2 surfaces
- `ui/src/pages/ProjectDetail.tsx` — Current location of RT2 tabs that must be promoted or demoted intentionally
- `ui/src/components/NewIssueDialog.tsx` — Existing RT2-aware capture flow for tasks and todos
- `ui/src/context/DialogContext.tsx` — Global entry point for opening the existing creation flow
- `ui/src/components/Rt2GovernancePanel.tsx` — Existing governance surface suitable for top-level promotion
- `server/src/routes/rt2-governance.ts` — Governance API already available behind company scope
- `server/src/routes/rt2-agent-marketplace.ts` — Marketplace API surface already present
- `server/src/routes/rt2-personal-pnl.ts` — P&L API surface already present

### Access, stub, and promotion boundaries
- `server/src/routes/authz.ts` — Company access pattern to preserve
- `server/src/routes/rt2-jarvis.ts` — Example of an RT2 surface that still has company-access TODOs
- `server/src/routes/rt2-collaboration.ts` — Collaboration route surface not ready for top-level promotion
- `ui/src/components/Rt2CollaborationPanel.tsx` — Stub-backed collaboration UI
- `ui/src/components/Rt2QualityPanel.tsx` — Stub-backed quality UI
- `server/src/services/rt2-collaboration.ts` — Placeholder collaboration service behavior

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `ui/src/components/NewIssueDialog.tsx`: Already supports RT2 task/todo capture with deliverable-oriented defaults and should anchor the first One-Liner experience.
- `ui/src/context/DialogContext.tsx`: Provides a global action pattern that can expose One-Liner from multiple entry points without duplicating form logic.
- `ui/src/components/Rt2GovernancePanel.tsx`: Already packages a governance surface that can be wrapped in a company-level page.
- `ui/src/components/Rt2DailyWikiPanel.tsx`, `ui/src/components/Rt2GraphPanel.tsx`, `ui/src/components/Rt2DailyBoard.tsx`: Existing brownfield pieces that can be recomposed into a single Knowledge route.
- `ui/src/pages/OrgChart.tsx`: Existing org visualization that can satisfy the first-class `Org` route without inventing a new domain.

### Established Patterns
- Company-prefixed routing is the established navigation contract. New RT2 routes should extend it rather than replace it.
- Global user actions are commonly launched through shell context/providers instead of isolated page-local state.
- The current RT2 implementation mostly lives inside `ProjectDetail` tabs, so promotion work is primarily a shell/IA refactor rather than a new backend.
- Server routes are expected to preserve company boundaries via explicit access checks, even in RT2-specific endpoints.

### Integration Points
- `ui/src/App.tsx`: Add company-scoped RT2 top-level routes and update default redirects.
- `ui/src/components/Sidebar.tsx` and `ui/src/components/MobileBottomNav.tsx`: Replace Paperclip-first primary nav with RT2-first navigation and secondary control-plane exposure.
- `ui/src/components/Layout.tsx`: Keep a stable shell while changing which routes count as primary.
- New company-level page components under `ui/src/pages/` or `ui/src/pages/rt2/`: Wrap existing RT2 assets into first-class routes.
- Existing company-scoped RT2 server routes for governance, marketplace, and P&L: Already provide backend anchors for top-level promotion.

</code_context>

<deferred>
## Deferred Ideas

- Freeform natural-language parsing and draft synthesis for the One-Liner — Phase 2
- Multica-backed runtime lifecycle and runtime/orchestration linkage — Phase 3
- Append-only CQRS event stream and projector architecture — Phase 4
- Cumulative wikiLLM + Graphify knowledge persistence — Phase 5
- Context-grounded Jarvis, quality automation, hybrid retrieval, and non-stub collaboration/economy screens — Phases 6 and 7

</deferred>

---

*Phase: 01-rt2-shell-and-product-truth*
*Context gathered: 2026-04-24*
