# Phase 52: Supporting Surfaces and Identity Regression Gate - Context

**Gathered:** 2026-04-30
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 52 finishes v2.8 by repositioning Jarvis, daily wiki, graph, and economy features as supporting evidence for the daily work board, and by adding a focused RealTycoon2 Korean UX/identity regression gate. It owns contextual board/card evidence surfaces for SUPPORT-01 and SUPPORT-02, plus a repeatable verification path for SUPPORT-03.

This phase should not rebuild the 3-lane daily board, card quick edit/filter/search/sort, or One-Liner capture review flow. Those are already Phase 49-51. Phase 52 may extend the daily work page, board/card detail evidence, existing Jarvis/wiki/graph/economy panels, and narrow test/script coverage only where required to make supporting surfaces and identity regression checks coherent.

</domain>

<decisions>
## Implementation Decisions

### Supporting Surface Placement
- **D-01:** The daily work board remains the primary work surface. Jarvis, wiki, graph, and economy should appear as contextual support beside or within board/card detail evidence, not as competing first-class dashboard/cockpit areas.
- **D-02:** Prefer a compact board-side evidence rail or card detail evidence drawer over adding more large panels below the board. The surface should answer "why does this card matter?" without moving the operator away from `daily-work`.
- **D-03:** Existing dedicated Knowledge/Governance/Marketplace pages can remain for deep operations, but Phase 52's success path must be visible from daily work and tied to selected board context.
- **D-04:** The current `Rt2DailyBoard` aside with `Jarvis 요약`, Gold/XP, 제출 산출물, 품질 상태, and gap flags is the starting point. Extend or replace that area with richer evidence tabs/sections instead of introducing a separate support dashboard.

### Card Evidence Model
- **D-05:** Card-level supporting evidence should group four categories: `Jarvis 추천`, `지식 근거`, `그래프 연결`, and `경제 근거`.
- **D-06:** Evidence should be compact by default: counts, top 1-3 recommendations/citations, stale/contradiction warnings, gold/base-price/quality summary, and links to deeper pages only when needed.
- **D-07:** Jarvis advice and citations must be framed as recommendation/evidence, not instructions. Use Korean copy that makes approval/review status explicit and preserves operator control.
- **D-08:** Daily wiki and semantic citations should show source label, freshness, contradiction status, and citation target where available. Do not show raw English API labels such as `stale`, `graph_node`, or `citationTarget` in product-facing copy.
- **D-09:** Graph evidence should emphasize task/todo/deliverable/wiki relationships and surprising or missing links. Avoid making a full Mermaid graph the default daily-board support view; detailed graph visualization remains a deeper Knowledge surface.
- **D-10:** Economy evidence should connect card deliverables, base price/Gold estimate, quality state, and settlement/governance state. It should not imply automatic payout if approval/quality gates are still pending.

### Data And API Shape
- **D-11:** Reuse existing RT2 services and client APIs before adding new read models: `rt2JarvisRuntimeApi.getTaskAdvice`, `rt2DailyReportApi.getWiki/queryWiki`, `rt2GraphApi`, `rt2-gamification`/`rt2-economy`, and existing daily board card metadata.
- **D-12:** If the daily board payload already contains enough summary fields, compose evidence client-side in `DailyWorkPage`/`Rt2DailyBoard`. Add a narrow server aggregator only if repeated client queries become inconsistent or tests show missing joins.
- **D-13:** Prefer task/card identity as the join key. Evidence must resolve from the active daily card's `todoIssueId`, task issue/project context, deliverable metadata, and report date; avoid broad company-wide support summaries that are not card-relevant.
- **D-14:** Preserve activity/audit semantics. Phase 52 evidence is primarily read/supportive unless an existing approval/review route is explicitly used; do not introduce hidden Jarvis auto-apply behavior.

### Product Copy And Visual Treatment
- **D-15:** Product-facing labels must be Korean-first and RealTycoon2-facing. Legacy terms such as Paperclip, Paper Company, Multica, raw `Task Mesh`, `Loading graph...`, `No graph data available`, `Quality Score`, `Shadow Mode`, and other English defaults should not appear in the daily support surface.
- **D-16:** Keep the board utilitarian and dense. Use tabs, segmented controls, compact chips, disclosure rows, and small evidence lists. Avoid landing-page explanation, nested cards, oversized panels, or visually competing dashboard blocks.
- **D-17:** Existing components with English-heavy copy (`Rt2GraphPanel`, `Rt2QualityPanel`, parts of `Rt2GamificationPanel`) should either be localized before embedding into daily work or wrapped with a smaller Korean board-specific evidence component.
- **D-18:** Empty/loading/error states for support evidence should be Korean and operational: `연결된 지식 근거가 없습니다`, `Jarvis 추천을 불러오는 중`, `그래프 근거를 확인하지 못했습니다` style copy.

### Identity Regression Gate
- **D-19:** Add a focused verification path for product-facing identity regressions rather than scanning the whole monorepo indiscriminately. The gate should target UI routes/components/pages that users see.
- **D-20:** The gate should fail on product-facing `Paperclip`, `Paper Company`, `Multica`, obvious English default strings like `Loading...`, `No ... available`, and support-surface English labels, while allowing package names, imports, adapter/plugin internals, developer docs, and tests with explicit legacy fixtures.
- **D-21:** Prefer a small script under `scripts/` plus test coverage over broad ad hoc `rg` instructions. Add a package script such as `rt2:identity-gate` or integrate with an existing focused test script only if it stays low-noise.
- **D-22:** The gate report should print file, line, token/category, and why it is product-facing. It should be reviewable enough that future phases can add allowed internal paths without weakening the product surface check.
- **D-23:** Keep existing `scripts/check-forbidden-tokens.mjs` separate. It is a security/publish token scanner, not a RealTycoon2 identity/Korean UX regression gate.

### Verification
- **D-24:** Add or update focused `Rt2DailyBoard`/`DailyWorkPage` component tests for support evidence placement, Korean labels, card-context evidence, and absence of legacy product-facing identity terms.
- **D-25:** Add script-level tests for the identity regression gate, including allowed internal Paperclip references and failing product-facing examples.
- **D-26:** If new server/shared aggregator contracts are added, cover them with focused shared/server tests. If implementation only composes existing APIs in UI, route tests can stay limited to existing API behavior.
- **D-27:** Verification should include `pnpm typecheck`, focused Vitest tests for changed files, and the new identity gate command. Run full `pnpm test` only if feasible on this Windows host; full-suite timeout remains accepted debt and should be recorded if it blocks completion.

### the agent's Discretion
- Exact evidence rail/drawer layout, provided the daily board remains the primary surface and the support evidence is visible from `daily-work`.
- Whether support evidence is implemented as extensions inside `Rt2DailyBoard` or as small child components passed from `DailyWorkPage`, based on query ownership and testability.
- Exact allowlist mechanism for the identity gate, provided product-facing paths are checked by default and internal/developer surfaces are not noisy blockers.

</decisions>

<specifics>
## Specific Ideas

- Phase 49 made `daily-work` the first operational route and explicitly deferred detailed Jarvis/wiki/graph/economy evidence to Phase 52.
- Phase 50 made card quick edit and board controls complete; Phase 52 should not reopen edit semantics.
- Phase 51 connected One-Liner capture to the board and left Jarvis/wiki/graph/economy detailed evidence panels plus broader identity regression gate to Phase 52.
- `Rt2DailyBoard` already has a board aside with `Jarvis 요약`, Gold/XP, deliverable, quality, and gap summary. That is the natural support-surface anchor.
- `DailyWorkPage` already owns selected company, selected project, current user, board query, wiki query key, and capture queue query; it is a practical place to compose support evidence queries without changing the board persistence contract.
- `Rt2GraphPanel` is rich but English-heavy and full-graph oriented (`Task Mesh`, `Loading graph...`, `No graph data available`, English view labels). Use it as a deeper reference, not as the default compact daily support surface unless localized.
- `Rt2DailyWikiPanel` already has Korean headings and daily history evidence, but still exposes raw `History` and evidence tags. It can inform a compact Korean citation/evidence list.
- `rt2JarvisRuntimeApi.getTaskAdvice` and `server/src/services/rt2-jarvis.ts` already expose grounded citations, warnings, and advice for task issues. This is the best source for card-level Jarvis support.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Requirements
- `.planning/PROJECT.md` - v2.8 product identity and daily work UX goal, RT2-first product rule, and Phase 52 focus.
- `.planning/REQUIREMENTS.md` - `SUPPORT-01`, `SUPPORT-02`, and `SUPPORT-03` Phase 52 requirements.
- `.planning/ROADMAP.md` - Phase 52 goal and success criteria under v2.8.
- `.planning/phases/48-rt2-identity-and-korean-shell/48-CONTEXT.md` - Locked Korean-first RealTycoon2 identity decisions and product-facing/internal boundary.
- `.planning/phases/49-daily-work-kanban-core/49-CONTEXT.md` - Locked daily board primary route and Phase 52 support-surface deferral.
- `.planning/phases/50-work-card-editing-and-board-controls/50-CONTEXT.md` - Locked quick edit, board controls, and Phase 52 support-surface deferral.
- `.planning/phases/51-one-liner-to-board-capture-flow/51-CONTEXT.md` - Locked capture review flow and Phase 52 deferred evidence/regression work.
- `AGENTS.md` - Korean-first communication and RealTycoon2 terminology instruction for this repo.

### Daily Work Board And Support Surface Code
- `ui/src/pages/rt2/DailyWorkPage.tsx` - Primary daily board page, selected project/user context, board/capture queries, and likely support evidence composition point.
- `ui/src/components/Rt2DailyBoard.tsx` - Primary board component, existing Jarvis/Gold/XP/quality/gap aside, card data, capture inbox, and compact control patterns.
- `ui/src/components/Rt2DailyBoard.test.tsx` - Focused board tests to extend for support evidence and Korean identity assertions.
- `ui/src/api/rt2-daily-report.ts` - Daily board and daily wiki client APIs.
- `packages/shared/src/types/rt2-daily-report.ts` - Daily board/card/cockpit data contracts.
- `server/src/services/rt2-daily-report.ts` - Existing daily board summaries, wiki materialization, quality/gap metadata.

### Jarvis, Wiki, Graph, Economy Evidence
- `ui/src/api/rt2-jarvis-runtime.ts` - Client API for task advice, quality reviews, rewrite proposals, auto policy, and skill capabilities.
- `server/src/routes/rt2-jarvis.ts` - Jarvis runtime routes, including task advice.
- `server/src/services/rt2-jarvis.ts` - Grounded citation, warning, task advice, rewrite evidence, and approval semantics.
- `packages/shared/src/types/rt2-governance.ts` - `Rt2JarvisTaskAdvice`, grounded citation, warning, and rewrite/eval evidence types.
- `ui/src/components/Rt2DailyWikiPanel.tsx` - Existing daily wiki panel and history evidence rendering.
- `ui/src/api/rt2-knowledge.ts` - Knowledge and daily wiki client APIs.
- `ui/src/pages/rt2/KnowledgePage.tsx` - Existing knowledge search/citation routing behavior.
- `ui/src/components/Rt2GraphPanel.tsx` - Existing graph and task mesh panel, including views that can be localized or mined for compact evidence patterns.
- `ui/src/api/rt2-graph.ts` - Graph and graph report client APIs.
- `packages/shared/src/types/rt2-graph.ts` - Graph node/edge/evidence and task mesh view contracts.
- `server/src/services/rt2-task-mesh.ts` - Graph/wiki/task/deliverable/economy evidence projection and report generation.
- `ui/src/components/Rt2GamificationPanel.tsx` - Existing leaderboard/achievement/economy UI patterns and Korean labels to reuse selectively.
- `ui/src/api/rt2-economy.ts` - Economy, marketplace, settlement, and evidence-status API types.
- `ui/src/api/rt2-gamification.ts` - Gold/balance/cost client API helpers.
- `packages/shared/src/types/rt2-gamification.ts` - XP/Gold/achievement/economy shared contracts.

### Identity Gate And Existing Identity Tests
- `scripts/check-forbidden-tokens.mjs` - Existing forbidden-token scanner to keep separate from RT2 identity checks.
- `package.json` - Add any new focused identity gate script here.
- `ui/src/context/BreadcrumbContext.tsx` - Runtime document title authority.
- `ui/src/context/BreadcrumbContext.test.tsx` - Existing RealTycoon2 title assertions.
- `ui/src/components/SidebarAccountMenu.test.tsx` - Existing assertion that account menu shows RealTycoon2 version instead of Paperclip version.
- `ui/src/components/CommandPalette.test.tsx` - Existing RealTycoon2 product-copy regression assertion.
- `ui/src/App.tsx`, `ui/src/components/Sidebar.tsx`, `ui/src/components/MobileBottomNav.tsx`, `ui/src/pages/rt2/OneLinerPage.tsx`, `ui/src/pages/rt2/DailyWorkPage.tsx` - Product-facing routes/shell likely included in the focused identity gate.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `Rt2DailyBoard` already renders the daily board, compact metadata, quick edit, capture inbox, save states, and a support aside with Jarvis/cockpit summary.
- `DailyWorkPage` already composes selected company/project/user context and board query state, making it a natural place to request task advice/wiki/graph/economy evidence for the active board context.
- `rt2JarvisRuntimeApi.getTaskAdvice` already provides task-scoped Jarvis advice with citations and warnings.
- `Rt2DailyWikiPanel` already renders daily wiki summary/history and can be adapted into smaller Korean evidence rows.
- `Rt2GraphPanel` already surfaces graph relationships, task evidence, knowledge refs, and economy view data, but its current UX is too broad and English-heavy for default board support.
- `Rt2GamificationPanel` and economy APIs already expose Gold/cost/economy information that can support board evidence if scoped to card/project context.
- Existing tests already assert RealTycoon2 title/account/command-palette copy, giving Phase 52 a base for a broader focused identity gate.

### Established Patterns
- Product-facing UI is Korean-first; route segments, API names, imports, and package names can remain English/internal.
- Daily board changes should preserve board persistence, daily wiki materialization, and existing capture review behavior.
- Focused component and script tests are preferred over full-suite reliance on this Windows host.
- Support evidence should reuse existing RT2 projections and services rather than duplicating a new knowledge/economy subsystem.
- Legacy Paperclip naming is allowed in package names, adapters, plugin SDK, MCP/server internals, developer docs, and tests with explicit fixtures, but not in operator-facing RT2 product surfaces.

### Integration Points
- Extend `DailyWorkPage.tsx` and/or `Rt2DailyBoard.tsx` with selected-card or board-context support evidence.
- Add small support evidence components if keeping `Rt2DailyBoard` manageable improves testability.
- Query `rt2JarvisRuntimeApi.getTaskAdvice` for selected task/card context when a card has a stable task issue id.
- Reuse `rt2DailyReportApi.getWiki/queryWiki`, `rt2GraphApi`, and existing economy/gamification APIs where they can be scoped by company/project/report date/card.
- Localize or avoid embedding English-heavy full panels directly in the daily board.
- Add a focused identity regression script and script tests under `scripts/`, then expose it through `package.json`.

</code_context>

<deferred>
## Deferred Ideas

- Rebuilding daily board lane semantics, movement, or default route belongs to Phase 49 and is out of scope.
- Reopening card quick edit, filter, search, sort, or field ownership belongs to Phase 50 and is out of scope.
- Reworking One-Liner capture parser, draft revision, promotion, duplicate handling, or source evidence lifecycle belongs to Phase 51 and is out of scope.
- Full app-store native distribution, cross-company federation, and Jarvis autonomous apply without approval remain future milestone scope.
- A full repo/product rebrand away from internal `@paperclipai/*` package naming is not Phase 52; the target is product-facing identity regression.

</deferred>

---

*Phase: 52-supporting-surfaces-and-identity-regression-gate*
*Context gathered: 2026-04-30*
