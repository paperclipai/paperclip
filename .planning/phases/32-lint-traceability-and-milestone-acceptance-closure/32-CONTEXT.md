# Phase 32: Lint Traceability and Milestone Acceptance Closure - Context

**Gathered:** 2026-04-28
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 32 closes the remaining v2.4 audit gaps for consistency linting and final milestone acceptance. It repairs Phase 29 traceability artifacts, adds missing Nyquist validation for lint behavior, proves the graph/wiki to scheduled-lint integration path, and reruns or reconstructs milestone acceptance evidence. It does not add new lint capabilities unless verification proves LINT-01 through LINT-04 cannot be honestly accepted from the current implementation.

</domain>

<decisions>
## Implementation Decisions

### Closure Artifact Scope
- **D-01:** Update `.planning/phases/29-consistency-linting-batch/29-01-SUMMARY.md` frontmatter with `requirements-completed` for LINT-01, LINT-02, LINT-03, and LINT-04 only if the existing verification and focused tests still support acceptance.
- **D-02:** Create `.planning/phases/29-consistency-linting-batch/29-VALIDATION.md` with Nyquist-style validation scenarios for scheduled execution, evidence-only findings, `embedding_consistency`, read-only behavior, and no on-write lint trigger.
- **D-03:** Keep Phase 32 as audit closure first. Source changes are allowed only when traceability or validation reveals a concrete lint implementation gap.

### Evidence Standard
- **D-04:** Every accepted LINT requirement must cite exact code and test evidence. Minimum evidence: implementing service file, startup/scheduler wiring, route/API surface where relevant, focused test coverage, Phase 29 verification, and command results.
- **D-05:** Do not mark LINT requirements accepted from roadmap, context, or plan text alone. The acceptance matrix must line up across `REQUIREMENTS.md`, `29-VERIFICATION.md`, `29-01-SUMMARY.md` frontmatter, and `29-VALIDATION.md`.
- **D-06:** If a lint requirement is partial, record an explicit gap and avoid inflating milestone completion.

### Phase 29 Lint Closure
- **D-07:** LINT-01 should be verified against `rt2WikiLintService.lintWikiPages()` comparing scoped daily wiki pages and the scheduled runner invoking lint by company/project scope.
- **D-08:** LINT-02 should be verified against evidence-rich issue fields and tests that assert wiki rows are unchanged before and after linting.
- **D-09:** LINT-03 should be verified against `embedding_consistency` as a first-class issue type, summary count, semantic comparison count, and contradiction evidence.
- **D-10:** LINT-04 should be verified against `createRt2WikiLintScheduler()`, server startup wiring, nightly window gating, overlap prevention, and no coupling to daily wiki write/materialization paths.

### Cross-Phase Integration Closure
- **D-11:** Phase 32 must explicitly connect Phase 30's accepted WIKI and GRAPH closure artifacts to Phase 29 lint acceptance: board/domain events produce stable daily wiki pages, graph projection depends on those pages, and scheduled lint reads the stabilized wiki corpus.
- **D-12:** Phase 31 economy closure should be treated as a prerequisite for final milestone acceptance, but Phase 32 should not rework economy artifacts unless the final audit still finds a traceability blocker there.
- **D-13:** The final acceptance artifact should identify whether v2.4 now passes requirements, phase artifacts, integration, and flow gates. Any residual issue must be labeled as explicit deferred tech debt with evidence.

### Verification Run Handling
- **D-14:** Prefer focused lint verification first: `pnpm --filter @paperclipai/server test -- rt2-wiki-lint`, then `pnpm typecheck`, then `pnpm test` if practical.
- **D-15:** Record exact command outcomes in artifacts. If full `pnpm test` still fails in unrelated `worktree.test.ts` timeout or host-specific embedded Postgres skips, document that separately from LINT acceptance.
- **D-16:** Do not require `pnpm test:e2e`; AGENTS.md makes it a separate browser suite and it is not the default verification gate for this closure.

### the agent's Discretion
- Exact table shape and heading names can mirror Phase 30 and Phase 31 closure artifacts.
- The final milestone audit can be a new audit artifact or an update to `.planning/v2.4-MILESTONE-AUDIT.md`, as long as it preserves the original gap context and clearly records the post-closure result.
- If Phase 31 has not fully landed by the time Phase 32 executes, the planner may gate final milestone acceptance on the existing Phase 31 artifacts rather than duplicating their work.

</decisions>

<specifics>
## Specific Ideas

- Use traceability tables with columns: requirement, status, evidence, tests, residual risk.
- Use validation scenarios that map directly to LINT-01 through LINT-04, not generic "lint works" assertions.
- The final acceptance check should explicitly mention the original audit blocker: Phase 29 verification already passed, but summary frontmatter and VALIDATION.md were missing.
- Treat deterministic local contradiction heuristics plus injectable analyzer as acceptable Phase 29 evidence; live LLM/provider hardening remains future work.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product and Phase Scope
- `.planning/PROJECT.md` - RT2-first identity, knowledge/economy milestone context, and audit-closure operating preference.
- `.planning/REQUIREMENTS.md` - LINT-01 through LINT-04 traceability targets and current pending status.
- `.planning/ROADMAP.md` - Phase 32 goal, dependency, gap closure description, and success criteria.
- `.planning/STATE.md` - Current v2.4 planning state, even if stale relative to recent closure artifacts.
- `.planning/v2.4-MILESTONE-AUDIT.md` - Original audit gaps that Phase 32 must close or explicitly defer.

### Prior Phase Decisions and Evidence
- `.planning/phases/29-consistency-linting-batch/29-CONTEXT.md` - Locked lint implementation decisions: scheduled, evidence-only, `rt2WikiLintService`, `embedding_consistency`.
- `.planning/phases/29-consistency-linting-batch/29-01-PLAN.md` - Executed lint implementation plan and acceptance checks.
- `.planning/phases/29-consistency-linting-batch/29-01-SUMMARY.md` - Phase 29 implementation summary that needs requirements frontmatter repair.
- `.planning/phases/29-consistency-linting-batch/29-VERIFICATION.md` - Existing passed verification for LINT-01 through LINT-04.
- `.planning/phases/30-knowledge-artifact-and-verification-closure/30-CONTEXT.md` - Knowledge closure pattern and graph/wiki evidence anchors that feed lint acceptance.
- `.planning/phases/30-knowledge-artifact-and-verification-closure/30-VERIFICATION.md` - Accepted WIKI and GRAPH evidence, if present.
- `.planning/phases/31-economy-artifact-and-verification-closure/31-CONTEXT.md` - Economy closure dependency and final milestone acceptance context.

### Existing Code Evidence
- `server/src/services/rt2-wiki-lint.ts` - Lint service, `embedding_consistency` issue type, evidence snippets, semantic comparisons, scheduler, nightly gating, overlap prevention.
- `server/src/app.ts` - Server startup wiring for the scheduled wiki lint runner.
- `server/src/services/index.ts` - Export surface for lint service and scheduler.
- `server/src/routes/rt2-daily-report.ts` - Existing wiki lint route surface and daily report/wiki routes that must stay separate from scheduled lint execution.
- `packages/db/src/schema/rt2_v33_daily_wiki_pages.ts` - Daily wiki table used as the lint corpus.
- `server/src/services/rt2-knowledge-projector.ts` - Upstream daily wiki and graph projection evidence for cross-phase flow.
- `server/src/services/rt2-domain-events.ts` - Upstream `appendAndProject()` path that creates stable knowledge artifacts.

### Test Evidence
- `server/src/__tests__/rt2-wiki-lint.test.ts` - Focused tests for semantic contradiction evidence, read-only behavior, and scheduler nightly gating.
- `server/src/__tests__/rt2-knowledge-projector.test.ts` - Upstream knowledge projection tests, useful for graph/wiki-to-lint integration closure.
- `server/src/__tests__/rt2-knowledge-routes.test.ts` - Upstream knowledge route tests, if needed for final flow evidence.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `rt2WikiLintService.lintWikiPages()` already scopes daily wiki pages by company/project/date, performs structural checks, compares page pairs semantically, and returns `semanticComparisons`, evidence-rich issues, and `embeddingConsistency` summary counts.
- `analyzeWikiPageConsistency()` already produces deterministic contradiction-like `embedding_consistency` findings with page keys, related page metadata, confidence, and snippets.
- `createRt2WikiLintScheduler()` already provides nightly-window gating, overlap prevention, project-scope enumeration, run summaries, logging, start/stop hooks, and manual `runScheduledLintNow()` execution for tests.
- `29-VERIFICATION.md` already states LINT-01 through LINT-04 passed and records focused test/typecheck/full-suite outcomes.

### Established Patterns
- Phase closure artifacts after the v2.4 audit reset must be requirement-traceable and evidence-backed.
- Summary frontmatter is part of milestone acceptance, not cosmetic metadata.
- Validation artifacts should encode Nyquist scenarios: what could break, how it is checked, expected outcome, and evidence source.
- Verification should distinguish Phase-specific acceptance from unrelated full-suite failures or host-specific embedded Postgres skips.

### Integration Points
- Phase 32 writes planning artifacts in `.planning/phases/29-consistency-linting-batch/` and `.planning/phases/32-lint-traceability-and-milestone-acceptance-closure/`.
- Requirement traceability flows through `.planning/REQUIREMENTS.md`, `29-VERIFICATION.md`, `29-01-SUMMARY.md`, and the final milestone audit artifact.
- Any source fixes discovered during closure should stay limited to lint service/scheduler wiring, wiki lint route/result typing, daily wiki projector integration evidence, or focused lint tests.

</code_context>

<deferred>
## Deferred Ideas

- Live LLM or embedding-provider integration for production-grade contradiction detection remains future hardening.
- Auto-fix or remediation workflow for lint findings remains out of scope.
- Vector semantic search, pgvector-backed retrieval, and cross-company knowledge federation remain v2+ deferred items.
- Additional browser E2E coverage for lint inspection UI is outside this closure unless a concrete route/UI acceptance gap is found.

</deferred>

---

*Phase: 32-lint-traceability-and-milestone-acceptance-closure*
*Context gathered: 2026-04-28*
