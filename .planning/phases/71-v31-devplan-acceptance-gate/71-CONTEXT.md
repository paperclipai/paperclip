# Phase 71: v3.1 DevPlan Acceptance Gate - Context

**Gathered:** 2026-05-01T16:05:00+09:00
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 71 closes v3.1 by proving that DevPlan Core Convergence actually improved from the 64% baseline through focused checks, generated gate evidence, score delta reporting, and planning-document truth reconciliation.

This phase is an acceptance/audit gate, not a new product feature phase. It must consume the evidence from Phases 65-70: DevPlan truth/identity, Daily cockpit, Multica runtime alignment, wikiLLM living memory, Graphify v3 corpus graph sidecar, and Economy/Marketplace/P&L/CareerMate loop. It may add or extend deterministic gate scripts, focused tests, generated summaries/reports, validation/verification artifacts, and planning docs. It must not reopen the Phase 70 economy implementation or introduce new marketplace/runtime/wiki/graph capabilities.

</domain>

<decisions>
## Implementation Decisions

### Gate Topology
- **D-01:** Keep `scripts/rt2-devplan-alignment-gate.mjs` as the canonical DevPlan score matrix and completion-claim validator.
- **D-02:** Add a v3.1-specific acceptance wrapper rather than overloading the alignment matrix with command execution. The wrapper should run or validate focused checks, invoke/consume the DevPlan alignment gate, and write a durable `summary.json` plus `report.md`.
- **D-03:** The acceptance wrapper is the Phase 71 owner for `GATE-01` and `GATE-02`. The alignment gate row `v31-acceptance-gate` should become `complete` only after the wrapper script, wrapper tests, generated acceptance run, and planning artifacts exist.

### Focused Check Coverage
- **D-04:** The gate must cover these focused slices: DevPlan alignment, identity regression, Daily cockpit/OKR hierarchy, runtime execution evidence, wikiLLM memory, Graphify corpus sidecar, economy/CareerMate loop, and standard repo verification.
- **D-05:** Required command set should include the existing focused gate tests plus the smallest representative Vitest suites for each slice. `pnpm typecheck` and `pnpm test` remain the overall verification target, but `pnpm test:e2e` is not part of the default Phase 71 gate.
- **D-06:** The acceptance report must list each command, status, source/evidence path, and next command when a check fails. A failed focused check is a blocker, not accepted debt.

### Score Delta And Truth Semantics
- **D-07:** The generated summary must include `baselineScorePct`, `currentScorePct`, and `scoreDeltaPct`. A non-positive delta is a blocker.
- **D-08:** Unsupported complete claims, engine parity overclaims, missing owner phase, invalid status, or complete rows without evidence remain blockers through the alignment gate.
- **D-09:** Remaining blocker, accepted debt, and future scope must be reported as separate buckets. Accepted debt may be present only when it is named, source-linked, and has a concrete follow-up command or future-scope reason.
- **D-10:** The gate should not inflate the score by declaring future/public rollout scope complete. Public/open marketplace, autonomous Jarvis direct apply, cross-company federation, real native credential collection, payroll/payment export, and public store operations remain future scope unless already evidenced.

### Planning Artifact Closure
- **D-11:** Phase 71 must reconcile `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, `.planning/STATE.md`, `.planning/PROJECT.md`, and `.planning/MILESTONES.md` only after the gate passes.
- **D-12:** Phase 71 should produce normal closure artifacts: `71-VALIDATION.md`, `71-VERIFICATION.md`, and `71-01-SUMMARY.md`. These artifacts become the final v3.1 acceptance evidence.
- **D-13:** Final documentation should state the actual score delta from 64%, the final current score, whether blockers are zero, and which future-scope items remain intentionally out of scope.

### Dirty Evidence And Dependency Guard
- **D-14:** The acceptance wrapper should surface required evidence paths that are missing from the working tree as blockers.
- **D-15:** If required evidence anchor paths are dirty or untracked when the final gate runs, report them explicitly. For final milestone acceptance, dirty evidence anchors should block unless the report intentionally classifies them as unresolved handoff debt.
- **D-16:** Current local context shows Phase 70 is committed (`feat(70): connect economy loop and CareerMate evidence`), while some Phase 69 graph/corpus files and planning docs are still dirty/untracked. Phase 71 planning must account for this instead of silently treating the milestone as closed.

### the agent's Discretion
- Exact acceptance wrapper filename and output directory, provided the report is deterministic and easy to find from package scripts.
- Exact focused command list, provided every v3.1 requirement family is represented and broad `pnpm test:e2e` is not made default.
- Exact wording of accepted debt/future scope report sections, provided blockers, accepted debt, and future scope are not merged.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Milestone Truth
- `AGENTS.md` - Korean-first workflow, RealTycoon2 terminology, verification command policy, lockfile policy, and no-overplanning guidance.
- `.planning/PROJECT.md` - v3.1 DevPlan Core Convergence goal, 64% baseline, current Phase 65-70 completion claims, future-scope boundary.
- `.planning/REQUIREMENTS.md` - `GATE-01` and `GATE-02`, plus all v3.1 requirement families that the acceptance gate must audit.
- `.planning/ROADMAP.md` - Phase 71 goal, success criteria, and dependency on Phases 65-70.
- `.planning/STATE.md` - Current milestone progress and cumulative v3.1 context.
- `.planning/MILESTONES.md` - Active milestone status and final close truth.

### Prior Phase Context
- `.planning/phases/65-devplan-truth-and-identity-cleanup/65-CONTEXT.md` - Evidence-backed completion rule, engine parity boundary, and 64% baseline handling.
- `.planning/phases/66-daily-work-and-okr-cockpit-convergence/66-CONTEXT.md` - Daily cockpit, OKR hierarchy, and focused verification decisions.
- `.planning/phases/67-multica-runtime-execution-alignment/67-CONTEXT.md` - Runtime lifecycle, dispatch, cleanup, timeline, and verification decisions.
- `.planning/phases/68-wikillm-living-memory-workflow/68-CONTEXT.md` - wikiLLM export/update/Jarvis citation gate expectations.
- `.planning/phases/69-graphify-v3-corpus-graph-sidecar/69-CONTEXT.md` - Graphify sidecar boundary and corpus graph evidence requirements.
- `.planning/phases/70-economy-marketplace-p-l-and-careermate-loop/70-CONTEXT.md` - Economy/P&L/Marketplace/CareerMate evidence decisions.
- `.planning/phases/70-economy-marketplace-p-l-and-careermate-loop/70-01-PLAN.md` - Phase 70 implementation/acceptance mapping.
- `.planning/phases/70-economy-marketplace-p-l-and-careermate-loop/70-HANDOFF.md` - Notes that Phase 70 verification passed and warns not to stage `pnpm-lock.yaml`.

### Existing Gate Scripts And Evidence
- `scripts/rt2-devplan-alignment-gate.mjs` - Canonical v3.1 score matrix, blocker validation, and generated alignment report.
- `scripts/rt2-devplan-alignment-gate.test.mjs` - Focused tests for score, complete-claim evidence, and engine parity overclaim blockers.
- `scripts/rt2-identity-gate.mjs` - Product-facing RealTycoon2 identity regression scan.
- `scripts/rt2-identity-gate.test.mjs` - Identity gate focused tests.
- `scripts/rt2-milestone-artifact-gate.mjs` - Existing planning artifact gate pattern.
- `scripts/rt2-distribution-gate.mjs` - Existing final-gate pattern for summary/report generation, stable blocker codes, and regression evidence.
- `scripts/rt2-runtime-confidence.mjs` - Existing accepted-debt/future-scope reporting pattern.
- `.planning/devplan-alignment-runs/2026-05-01T05-59-17-123Z/report.md` - Latest pre-Phase-70 generated alignment report, current score 91%, economy partial, acceptance missing.
- `.planning/devplan-alignment-runs/2026-05-01T05-59-17-123Z/summary.json` - Machine-readable version of that pre-Phase-70 report.
- `package.json` - Existing `rt2:*` and `test:*` scripts where the v3.1 acceptance gate should be exposed.

### Representative Focused Test Anchors
- `ui/src/components/Rt2DailyBoard.test.tsx` - Daily cockpit, hierarchy, and economy evidence UI coverage.
- `ui/src/components/Rt2TaskPanel.test.tsx` - Runtime execution/timeline evidence UI coverage.
- `ui/src/components/Rt2QualityPanel.test.tsx` - Jarvis/wiki update review surface coverage.
- `packages/shared/src/rt2-daily-report.test.ts` - Daily cockpit shared contract coverage.
- `packages/shared/src/rt2-task.test.ts` - Runtime/task shared contract coverage.
- `packages/shared/src/rt2-knowledge.test.ts` - wikiLLM/knowledge shared contract coverage.
- `packages/shared/src/rt2-graph.test.ts` - Graphify corpus graph shared contract coverage.
- `packages/shared/src/rt2-gamification.test.ts` - CareerMate/economy progression shared contract coverage.
- `server/src/__tests__/rt2-task-routes.test.ts` - Runtime route/service evidence.
- `server/src/__tests__/rt2-knowledge-projector.test.ts` - wikiLLM projector evidence.
- `server/src/__tests__/rt2-knowledge-routes.test.ts` - wikiLLM route evidence.
- `server/src/__tests__/rt2-corpus-graph.test.ts` - Graphify sidecar route/service evidence.
- `server/src/__tests__/rt2-phase7-economy-marketplace.test.ts` - Economy/marketplace/P&L/CareerMate evidence coverage.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `scripts/rt2-devplan-alignment-gate.mjs` already calculates a 64% baseline, current score, blocker count, status counts, and writes timestamped `summary.json` and `report.md`.
- `scripts/rt2-devplan-alignment-gate.test.mjs` already proves complete-claim evidence rules and engine parity overclaim blockers.
- `scripts/rt2-distribution-gate.mjs` provides the best local pattern for final acceptance reports with blocker codes, passed checks, regression evidence, and generated artifacts.
- `scripts/rt2-runtime-confidence.mjs` provides a useful pattern for separating blockers, accepted debt, and deferred/future scope in operator-facing reports.
- `package.json` already contains `rt2:devplan-alignment-gate`, `test:devplan-alignment-gate`, `rt2:identity-gate`, and `test:identity-gate` scripts.

### Established Patterns
- Deterministic Node gate scripts are preferred for acceptance evidence.
- Generated evidence should live under `.planning/*-runs/<timestamp>/summary.json` and `report.md`.
- Completion truth must be backed by concrete file evidence, focused tests, and planning artifacts.
- Engine names are reference/internal unless the product-facing copy is explicitly explaining a boundary.
- `pnpm typecheck && pnpm test` is the normal verification target; `pnpm test:e2e` remains separate.

### Integration Points
- Add a new script such as `scripts/rt2-v31-acceptance-gate.mjs` with a corresponding focused test.
- Add package scripts such as `rt2:v31-acceptance-gate` and `test:v31-acceptance-gate`.
- Extend `scripts/rt2-devplan-alignment-gate.mjs` so the `v31-acceptance-gate` row is complete only after Phase 71 anchors exist.
- Update `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, `.planning/STATE.md`, `.planning/PROJECT.md`, and `.planning/MILESTONES.md` after the acceptance gate passes.
- Create Phase 71 validation, verification, and summary artifacts after implementation and verification.

</code_context>

<specifics>
## Specific Ideas

- Recommended output directory: `.planning/v31-acceptance-runs/<timestamp>/`.
- Recommended wrapper summary fields: `baselineScorePct`, `currentScorePct`, `scoreDeltaPct`, `alignmentRunDir`, `checks[]`, `blockers[]`, `acceptedDebt[]`, `futureScope[]`, and `planningTruth[]`.
- Recommended stable blocker codes: `V31_SCORE_DELTA_NOT_POSITIVE`, `V31_FOCUSED_CHECK_FAILED`, `V31_REQUIRED_EVIDENCE_MISSING`, `V31_DIRTY_EVIDENCE_ANCHOR`, `V31_ALIGNMENT_GATE_BLOCKED`, and `V31_PLANNING_TRUTH_MISMATCH`.
- Recommended future-scope buckets: public/open marketplace, autonomous Jarvis direct apply, cross-company federation, real native credential collection, payroll/payment export, public store operations.
- Recommended report title: `# RealTycoon2 v3.1 Acceptance Gate`.

</specifics>

<deferred>
## Deferred Ideas

- Public/open marketplace rollout remains future trusted ecosystem/public launch scope.
- Real billing, payroll export, HR compensation export, and external payment settlement remain out of scope.
- Autonomous Jarvis direct apply remains approval-first future scope.
- Cross-company federation full apply remains future scope.
- Actual native signing credential, APNs/Web Push provider secret collection, public store listing, marketing, and reviewer operations remain outside v3.1 acceptance.

</deferred>

---

*Phase: 71-v31-devplan-acceptance-gate*
*Context gathered: 2026-05-01T16:05:00+09:00*
