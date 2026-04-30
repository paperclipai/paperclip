# Phase 48: RT2 Identity and Korean Shell - Context

**Gathered:** 2026-04-30
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 48 locks the RealTycoon2-first Korean product identity across the app shell and startup surface. It covers the first viewport, navigation labels, settings and account copy, onboarding/no-company states, empty/error/loading/fallback states, browser title, mobile app title, and visible brand affordances. Product-facing UI must stop looking like an upstream Paperclip control plane.

This phase should not build the daily kanban board core, card quick editing, One-Liner board review flow, or supporting Jarvis/wiki/graph/economy evidence layout. Those are Phase 49-52. Phase 48 may rename navigation targets or redirect defaults only where needed to establish identity and shell semantics.

</domain>

<decisions>
## Implementation Decisions

### Brand surface and startup identity
- **D-01:** Default browser and install metadata should be RealTycoon2-first: `ui/index.html` must use `lang="ko"`, `apple-mobile-web-app-title="RealTycoon2"`, and `<title>RealTycoon2`.
- **D-02:** Keep `BreadcrumbContext` as the runtime document-title authority because it already sets `document.title` to `RealTycoon2` and page breadcrumbs.
- **D-03:** The existing `CompanyRail` RealTycoon2 icon can remain the primary compact brand mark, but fallback/loading/startup copy must explicitly say RealTycoon2 where a user would otherwise see a generic "Loading..." or setup page.
- **D-04:** Runtime branding marker comments containing `PAPERCLIP_*` may remain in `ui/index.html` only if they are internal build markers and not visible product copy. Visible strings and metadata must be RT2-first.

### Korean-first shell copy
- **D-05:** Convert product-facing shell/navigation labels in the core app chrome to Korean defaults. Priority labels include create action, dashboard/inbox/work/issues/routines/goals/workspaces/company/settings, account menu actions, company settings, instance settings, mobile navigation aria label, not-found copy, no-company/onboarding start pages, and cloud/bootstrap loading/error copy.
- **D-06:** Use RealTycoon2 terminology rather than literal legacy translations. Examples: "New Issue" becomes an RT2 work-capture action such as "업무 추가"; "Issues" becomes "업무"; "Goals" becomes "목표"; "Company settings" becomes "회사 설정"; "Instance settings" becomes "RealTycoon2 설정" or "인스턴스 설정" depending on context.
- **D-07:** Do not translate developer-only identifiers, API route names, package names, test fixture names, environment variables, or internal compatibility types. Paperclip can remain in source identifiers and internal docs, but not in user-visible app copy.
- **D-08:** Prefer concise Korean operational copy over marketing copy. This shell is a daily work system, not a landing page.

### Legacy naming cleanup
- **D-09:** Product-facing UI must not show `Paperclip`, `Paper Company`, or `Multica` except where a page is explicitly an internal/developer control-plane or compatibility surface. The account menu currently shows `Paperclip v{version}` and Paperclip docs text; this should become RealTycoon2-facing version/help copy or be moved behind a developer-facing label.
- **D-10:** The docs/help destination can stay pointed at existing docs only if the visible label is not "Paperclip docs" and the description clarifies it is RealTycoon2 help/reference. A separate future docs migration is out of scope.
- **D-11:** Tests that intentionally use legacy fixture data may keep fixture names, but product-facing component tests should assert Korean/RT2 output after copy changes.

### Settings, onboarding, and fallback behavior
- **D-12:** Settings copy should read as operator preferences for RealTycoon2, not an English instance-control-plane. General settings should Koreanize headings/descriptions for deployment/auth, log masking, keyboard shortcuts, backup retention, feedback sharing, and sign-out.
- **D-13:** Onboarding and no-company flows should guide the operator in Korean through creating a company and first agent/task, while preserving the existing route behavior and authenticated bootstrap command.
- **D-14:** Loading and error states should use Korean defaults and avoid bare "Loading..." / "Failed to..." strings in app shell routes. Reusable `PageSkeleton` can remain visual-only; text-bearing fallbacks need Korean copy.
- **D-15:** `NotFoundPage` should explain invalid company prefix and missing route in Korean and route users back to the daily work entry point.

### Navigation priority
- **D-16:** The first operational destination remains the existing `one-liner` path for Phase 48. Do not change the default route to a new board path in this phase unless it is only a label/copy change; Phase 49 owns making the 3-lane board the primary work surface.
- **D-17:** Existing route structure and company-prefix redirects should be preserved. Rename user-facing labels without breaking deep links, plugin slots, or test helpers.
- **D-18:** Supporting surfaces such as knowledge, marketplace, P&L, governance, plan alignment, control plane, agents, projects, and workspaces should not compete with the main daily work identity. Phase 48 should label them as support/admin surfaces where visible.

### Verification
- **D-19:** Add or update focused UI tests around the shell components that contain visible product identity: `App`, `Sidebar`, `SidebarAccountMenu`, `SidebarCompanyMenu`, `InstanceSidebar`, `CompanySettingsSidebar`, `NotFoundPage`, and document metadata/title behavior.
- **D-20:** Add a focused regression check or test assertion that product-facing UI source/output no longer contains visible `Paperclip`, `Paper Company`, `Multica`, or English default shell copy in the Phase 48 target files. Avoid a repo-wide ban because internal package names and developer docs still legitimately contain Paperclip.
- **D-21:** Verification should include `pnpm typecheck` and focused Vitest tests for changed UI components. Run default `pnpm test` if feasible; if Windows host constraints or unrelated long-running suites block it, record the focused evidence explicitly.

### the agent's Discretion
- Exact Korean phrasing, provided it is short, operator-oriented, and consistent across shell surfaces.
- Whether to centralize brand/copy constants in a small UI utility or edit component-local copy directly. Prefer a shared constant only where it reduces duplicated product names.
- Exact test boundaries, provided they cover visible shell identity and avoid brittle assertions against internal/developer-only strings.

</decisions>

<specifics>
## Specific Ideas

- The user concern captured by v2.8 is that launching the app still feels like Paperclip/Paper Company/control-plane tooling instead of a Korean RealTycoon2 daily work system.
- The app already has partial RT2 identity: `BreadcrumbContext` titles use `RealTycoon2`, `CompanyRail` has a RealTycoon2 aria label, `MobileBottomNav` has Korean labels, and RT2 pages/components exist.
- Main remaining identity leaks are visible metadata and English shell copy, especially `ui/index.html`, `Sidebar`, `SidebarAccountMenu`, settings sidebars/pages, startup/loading states, not-found states, and account/docs/version copy.
- Phase 48 should make the first perceived product identity correct before Phase 49 makes the board the first operational surface.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Requirements
- `.planning/PROJECT.md` - v2.8 milestone goal, RT2-first identity rule, current product context, and deferred scope.
- `.planning/REQUIREMENTS.md` - `IDENT-01`, `IDENT-02`, `IDENT-03`, and `IDENT-04` Phase 48 requirements.
- `.planning/ROADMAP.md` - Phase 48 goal and success criteria under v2.8.
- `.planning/STATE.md` - Current milestone state and user concern about Paper Company / English control-plane feel.
- `AGENTS.md` - Korean-first communication and RealTycoon2 terminology instruction for this repo.

### Existing Shell And Identity Code
- `ui/index.html` - Static document metadata, mobile app title, title, favicon/runtime branding markers, and theme bootstrap.
- `ui/src/context/BreadcrumbContext.tsx` - Runtime document title behavior using RealTycoon2.
- `ui/src/App.tsx` - Startup gates, redirects, onboarding/no-company pages, route defaults, and loading/error fallbacks.
- `ui/src/components/Layout.tsx` - Main app shell composition, sidebar choice, account menu, mobile behavior, and local storage key.
- `ui/src/components/CompanyRail.tsx` - Compact RealTycoon2 mark, company switching, and add-company affordance.
- `ui/src/components/Sidebar.tsx` - Main navigation labels and work/company sections.
- `ui/src/components/SidebarAccountMenu.tsx` - Account/profile/settings/docs/version copy and visible Paperclip docs/version leak.
- `ui/src/components/SidebarCompanyMenu.tsx` - Company menu actions and settings copy.
- `ui/src/components/InstanceSidebar.tsx` - Instance settings navigation labels.
- `ui/src/components/CompanySettingsSidebar.tsx` - Company settings navigation labels.
- `ui/src/components/MobileBottomNav.tsx` - Existing Korean mobile nav labels and route pattern.
- `ui/src/pages/InstanceGeneralSettings.tsx` - General settings headings/descriptions and feedback terms link text.
- `ui/src/pages/NotFound.tsx` - Route fallback copy and daily entry redirect.
- `ui/src/components/PageSkeleton.tsx` - Visual loading skeleton pattern that can be reused where text loading copy is removed.
- `ui/src/components/EmptyState.tsx` - Reusable empty-state component used by product-facing pages.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `BreadcrumbContext` already centralizes `document.title` and should remain the title authority.
- `CompanyRail` already exposes a RealTycoon2 brand mark and Korean add-company affordance.
- `MobileBottomNav` already demonstrates concise Korean navigation labels for daily mobile use.
- `PageSkeleton` provides non-text loading states, useful for replacing bare English "Loading..." app fallbacks.
- Existing component-level tests for `Sidebar`, `SidebarAccountMenu`, `CompanySettingsSidebar`, `CompanyContext`, `Layout`, `App`, and RT2 board components provide update points for copy assertions.

### Established Patterns
- React + Vite UI uses component-local copy with `useBreadcrumbs` per page, not a full i18n framework.
- Routes are stable English path segments; user-facing labels can change independently from URLs.
- The app uses Lucide icons in navigation and account menus.
- Settings pages use card-like sections with headings, descriptions, and small status boxes.
- Product-facing RT2 pages already mix Korean headings with internal route/component names.

### Integration Points
- Change static metadata in `ui/index.html`.
- Update shell copy in `App.tsx`, `Sidebar.tsx`, `SidebarAccountMenu.tsx`, `SidebarCompanyMenu.tsx`, `InstanceSidebar.tsx`, `CompanySettingsSidebar.tsx`, `NotFound.tsx`, and relevant settings pages.
- Update focused tests that currently assert English/Paperclip output.
- Add a narrow identity regression test/check against the changed product-facing shell files rather than scanning the whole repo.
- Keep plugin APIs, package names, adapter names, server internals, and developer docs stable unless visible product copy requires a label override.

</code_context>

<deferred>
## Deferred Ideas

- Making the 3-lane daily work board the first operational work surface belongs to Phase 49.
- Work card quick edit, filters, sort, and search belong to Phase 50.
- One-Liner to board inbox/review/draft flow belongs to Phase 51.
- Repositioning Jarvis/wiki/graph/economy as card evidence surfaces and adding the broader identity regression gate belongs to Phase 52.
- Full docs-site rebrand away from Paperclip is outside this phase unless a visible app link label needs RT2 wording.

</deferred>

---

*Phase: 48-rt2-identity-and-korean-shell*
*Context gathered: 2026-04-30*
