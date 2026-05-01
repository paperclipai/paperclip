# Phase 66: Daily Work and OKR Cockpit Convergence - Context

**Gathered:** 2026-05-01
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 66 converges the first RealTycoon2 operating screen on the v3.1 DevPlan cockpit target: a three-panel daily work surface with left OKR tree, center daily report/board/task mesh, and right detail/Jarvis/chat/evidence support. It also closes the Mission -> Objective -> Key Result -> Project -> Task -> To-Do rollup gap that Phase 65's DevPlan matrix marked as partial.

This phase must not implement Phase 67 Multica runtime lifecycle, Phase 68 wikiLLM export/update loop, Phase 69 Graphify v3 corpus sidecar, Phase 70 marketplace/P&L/CareerMate loop, or Phase 71 final acceptance gate. It may update the DevPlan alignment matrix only for the Daily cockpit and Mission-to-To-Do rows it actually proves.

</domain>

<decisions>
## Implementation Decisions

### Three-Panel Daily Cockpit
- **D-01:** Keep `DailyWorkPage` and `Rt2DailyBoard` as the first operating surface. Do not create a parallel dashboard. The existing three-column layout is the convergence target: left OKR tree/context, center board and task mesh, right Jarvis/knowledge/graph/economy evidence.
- **D-02:** Preserve the canonical daily lanes `todo`, `doing`, and `done`, shown as `할 일`, `진행 중`, and `완료`. Phase 66 should not reopen the Phase 49-50 lane and quick-edit decisions.
- **D-03:** The center panel remains dense and operational: One-Liner review inbox, filter/search/sort toolbar, and task cards stay in one cockpit rather than moving to separate pages.

### One-Liner Review Evidence
- **D-04:** One-Liner drafts in the cockpit should be filterable by source, status, and evidence class (`duplicate`, `failed_sync`, `approval_waiting`, `revised`). Use server-side query normalization for route filters and UI-side controls for fast cockpit interaction.
- **D-05:** The cockpit must show capture source reliability evidence: draft counts, failure counts, retries, promoted counts, and promotion latency by source. This makes One-Liner input -> review -> Task/To-Do/Deliverable evidence visible in the same daily surface.
- **D-06:** Promoted drafts should remain auditable from the cockpit with original draft/revision links and promoted Task/To-Do/Deliverable IDs. Do not hide the source chain after promotion.

### Mission-To-To-Do Rollup
- **D-07:** Add an explicit `hierarchyRows` contract to the daily cockpit API. It should represent the visible path from goal parent chain through project, task, and to-do rather than relying on prose or UI-only reconstruction.
- **D-08:** Do not add a new Mission/Object/KR schema in this phase. Reuse existing `goals.level`, `goals.parentId`, `projects.goalId`, `project_goals`, `rt2V33TaskProfiles.goalId`, and issue parent links.
- **D-09:** Each hierarchy row must include rollup evidence: status, progress percent, deliverable count, submitted deliverable count, gold impact, and gap flags. This is the API/UI consistency proof for DAILY-03.
- **D-10:** The left cockpit panel should label the hierarchy as `OKR 트리 · Mission -> To-Do` and render node kinds (`Mission`, `Objective`, `KR`, `Project`, `Task`, `To-Do`) plus rollup metrics.

### DevPlan Alignment Closure
- **D-11:** Update `scripts/rt2-devplan-alignment-gate.mjs` so `Daily Work cockpit` and `Mission to To-Do hierarchy` become `complete` only after the cockpit UI, shared contract, service, and focused tests exist.
- **D-12:** The expected DevPlan score after Phase 66 is 72%, not final v3.1 completion. Phase 71 still owns the final acceptance score delta after Phases 67-70.

### Verification
- **D-13:** Focused verification should include shared daily/task contract tests, `Rt2DailyBoard` UI tests, DevPlan alignment gate tests, and package-level shared/server/ui typecheck.
- **D-14:** Server route tests that depend on embedded Postgres may skip on Windows unless `PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS=true` is set. Treat the route test files as maintained evidence, but record the host skip honestly.
- **D-15:** Do not run `pnpm test:e2e` as the default Phase 66 check.

### the agent's Discretion
- Exact visual spacing and compact chip styling for the left hierarchy tree.
- Whether source/status/evidence filters are server-side, UI-side, or both, provided the API supports route-level filtering and the cockpit supports operator controls.
- Exact wording of capture reliability labels, provided product-facing text remains Korean-first and RealTycoon2-facing.

</decisions>

<specifics>
## Specific Ideas

- Phase 65's alignment report named two Phase 66 gaps: `Daily Work cockpit` and `Mission to To-Do hierarchy`.
- Existing `Rt2DailyBoard` already has three panels and One-Liner review; Phase 66 should converge and prove it, not rewrite it.
- A useful `hierarchyRows` shape is `path[]` plus `rollup`, where `path` contains goal/project/task/todo nodes and `rollup` contains progress, deliverable, gold, and gap evidence.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Truth
- `AGENTS.md` - Korean-first workflow, RealTycoon2 terminology, verification command policy, and lockfile policy.
- `.planning/PROJECT.md` - v3.1 DevPlan Core Convergence goal, RealTycoon2-first identity, daily cockpit target, and brownfield constraints.
- `.planning/REQUIREMENTS.md` - `DAILY-01`, `DAILY-02`, and `DAILY-03`.
- `.planning/ROADMAP.md` - Phase 66 goal, success criteria, and dependencies.
- `.planning/STATE.md` - Phase 66 current position and v3.1 context.
- `.planning/devplan-alignment-runs/2026-05-01T01-34-28-588Z/report.md` - Phase 65 baseline showing Phase 66 daily cockpit and hierarchy gaps.
- `.planning/phases/65-devplan-truth-and-identity-cleanup/65-CONTEXT.md` - Locked Phase 65 boundary and DevPlan evidence rule.

### Prior Daily Work Decisions
- `.planning/phases/10-daily-report-and-okr-kpi-cockpit/10-CONTEXT.md` - Existing daily cockpit and OKR/KPI trace decisions.
- `.planning/phases/49-daily-work-kanban-core/49-CONTEXT.md` - Canonical daily board route and `todo/doing/done` lane decisions.
- `.planning/phases/50-work-card-editing-and-board-controls/50-CONTEXT.md` - Quick edit, filters, search, sort, and card metadata ownership.
- `.planning/phases/51-one-liner-to-board-capture-flow/51-CONTEXT.md` - One-Liner review queue and promotion decisions.

### Code And Tests
- `ui/src/pages/rt2/DailyWorkPage.tsx` - First operating screen and query orchestration.
- `ui/src/components/Rt2DailyBoard.tsx` - Three-panel cockpit UI, board, One-Liner review, hierarchy display, and evidence panels.
- `ui/src/components/Rt2DailyBoard.test.tsx` - Focused cockpit UI coverage.
- `ui/src/api/rt2-tasks.ts` - Capture queue and reliability report client API.
- `ui/src/lib/queryKeys.ts` - Capture queue and reliability query cache keys.
- `packages/shared/src/types/rt2-daily-report.ts` - Daily cockpit, hierarchy, and rollup shared contract.
- `packages/shared/src/types/rt2-task.ts` - Capture queue filters and reliability report shared contract.
- `packages/shared/src/validators/rt2-task.ts` - Capture queue filter query normalization.
- `packages/shared/src/rt2-daily-report.test.ts` - Shared cockpit hierarchy contract coverage.
- `packages/shared/src/rt2-task.test.ts` - Shared capture filter contract coverage.
- `server/src/services/rt2-daily-report.ts` - Daily board read model, hierarchy row construction, and rollup evidence.
- `server/src/services/rt2-work-board.ts` - Capture queue filters and reliability report aggregation.
- `server/src/routes/rt2-tasks.ts` - Capture queue filter and reliability report routes.
- `server/src/__tests__/rt2-daily-report-routes.test.ts` - Route-level hierarchy evidence coverage.
- `server/src/__tests__/rt2-task-routes.test.ts` - Route-level capture filter and reliability report coverage.
- `scripts/rt2-devplan-alignment-gate.mjs` - v3.1 score and daily cockpit/hierarchy completion truth.
- `scripts/rt2-devplan-alignment-gate.test.mjs` - Focused alignment gate score and blocker tests.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `Rt2DailyBoard` already provides the three-panel cockpit shell, daily board controls, One-Liner review inbox, and right-side Jarvis/knowledge/graph/economy evidence.
- `rt2DailyReportService.listDailyBoard` already reads assigned To-Dos, task profiles, project goals, deliverables, work-board metadata, and cockpit summaries.
- `rt2WorkBoardService.listCaptureQueue`, `promoteCaptureDraft`, `failCaptureDraft`, `reviseCaptureDraft`, and `transitionCaptureDraft` already provide the review lifecycle.
- `scripts/rt2-devplan-alignment-gate.mjs` already enforces evidence-backed completion rows and score calculation.

### Established Patterns
- Product-facing UI copy is Korean-first; route paths and API identifiers remain English/internal where appropriate.
- Daily board changes should preserve activity logging and daily wiki materialization.
- Focused Vitest/jsdom tests beside UI components are the right evidence for cockpit rendering.
- Server route tests use embedded Postgres and can legitimately skip on Windows by default.

### Integration Points
- Extend shared daily cockpit types before updating server and UI consumers.
- Build hierarchy rows in `rt2DailyReportService` from existing goal/project/task/to-do relationships.
- Render hierarchy rows in the left cockpit panel without breaking existing `traceRows`.
- Add capture filter/reliability route support in `rt2-tasks` and reuse it from `DailyWorkPage`.
- Update DevPlan alignment rows after focused tests prove the new API/UI evidence.

</code_context>

<deferred>
## Deferred Ideas

- Phase 67 owns runtime-aware queue, heartbeat, cancellation, progress stream, and work-card runtime evidence.
- Phase 68 owns wikiLLM `index.md`/`log.md`/topic page export and Jarvis reviewable wiki updates.
- Phase 69 owns Graphify v3 corpus graph sidecar, file cache, provenance, clustering, and query/report parity.
- Phase 70 owns marketplace, P&L, amoeba economy, and CareerMate progression in the primary navigation loop.
- Phase 71 owns final v3.1 score delta and acceptance gate.
- New dedicated Mission/Object/KR schema remains future scope unless existing `goals.level` and parent chain stop being enough.

</deferred>

---

*Phase: 66-daily-work-and-okr-cockpit-convergence*
*Context gathered: 2026-05-01*
