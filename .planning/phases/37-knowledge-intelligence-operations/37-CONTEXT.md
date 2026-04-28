# Phase 37: Knowledge Intelligence Operations - Context

**Gathered:** 2026-04-28
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 37 makes the v2.5 semantic knowledge loop operationally trustworthy. It must give operators a health surface for semantic index state, contradiction review state, and Jarvis grounding state; add batch health checks that fail clearly when traceability is broken; and produce milestone verification artifacts proving all v2.5 semantic knowledge requirements. It does not add new semantic retrieval behavior, new contradiction resolution semantics, provider-only generation, cross-company federation, or autonomous knowledge rewrites.

</domain>

<decisions>
## Implementation Decisions

### Operations Surface
- **D-01:** The first operations surface should live inside the existing RT2 knowledge operator area, preferably `KnowledgePage`, as an operations/health view rather than a disconnected dashboard route.
- **D-02:** The UI must summarize semantic index health, queue/run state, stale source count, provider/fallback mode, embedding model, and last successful run from the existing semantic index status/run data.
- **D-03:** The same surface must also show contradiction review and Jarvis grounding health signals: open contradiction count, recently resolved contradiction evidence, stale semantic chunks, Jarvis citation count/warning state where available, and clear degraded/healthy badges.
- **D-04:** Health cards should be dense and evidence-forward. Avoid explanatory marketing panels; show counts, modes, last run timestamps, warnings, and links/actions to the relevant search, bridge, or Jarvis flow.

### Batch Health Gate
- **D-05:** Add a company-scoped semantic knowledge health check API/service that aggregates semantic index, contradiction review, and Jarvis grounding traceability into one route-testable result.
- **D-06:** Batch health checks must fail with explicit reason codes when required traceability is missing: no semantic index run/chunks, stale chunks above threshold, open contradictions affecting indexed sources, Jarvis grounding citations missing for available task advice, or citation targets lacking routable metadata.
- **D-07:** The gate must stay deterministic in local dev and CI. It should rely on stored rows and deterministic fallback behavior, not live provider availability.
- **D-08:** Health output should distinguish `healthy`, `degraded`, and `failed` states so the UI can warn without blocking every operator flow.

### Verification Artifact Closure
- **D-09:** Phase 37 must produce verification artifacts that cover all 19 v2.5 requirements, not only OPS-01 through OPS-03.
- **D-10:** Verification should cite tests, route evidence, and user-facing flow notes for Phase 33 semantic index, Phase 34 semantic search, Phase 35 contradiction review, Phase 36 Jarvis grounding, and Phase 37 operations.
- **D-11:** Requirements traceability must be updated in `.planning/REQUIREMENTS.md` and phase summaries/validation artifacts should be checked before milestone close.
- **D-12:** If any prior phase artifact is missing or weaker than the implemented code, Phase 37 should create closure notes and targeted tests rather than rewriting the feature.

### Scope Boundaries
- **D-13:** Provider/fallback mode is observational in this phase. Do not make live embedding or LLM provider mandatory.
- **D-14:** Contradiction review remains approval-first. Do not add automatic wiki/graph rewrites from health findings.
- **D-15:** Cross-company knowledge federation, native mobile semantic operations, and autonomous maintenance stay deferred beyond v2.5.

### the agent's Discretion
- Exact health thresholds, card ordering, copy for degraded states, and whether the health API lives under `/rt2/knowledge/health` or `/rt2/semantic-operations/health` are planner discretion as long as the route is company-scoped, deterministic, and test-covered.
- The planner may choose whether to introduce shared types under `packages/shared/src/types/rt2-knowledge.ts` or a new operations-specific type file, but UI/API/server contracts must not drift.

</decisions>

<specifics>
## Specific Ideas

- Treat Phase 37 as the milestone close cockpit: one place where an operator can see whether semantic index, search, contradiction review, and Jarvis grounding are actually trustworthy.
- "Last successful run" should be separate from "last run" so a recent failed run does not hide the last known healthy state.
- Route evidence should prove company boundary and deterministic fallback behavior, not just happy-path UI rendering.
- The operations surface should link back into existing flows instead of duplicating them: reindex/status for semantic index, Bridge contradiction review for conflicts, Jarvis task advice for grounded answers, search tab for evidence retrieval.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product and Phase Scope
- `.planning/PROJECT.md` - RT2-first identity, v2.5 milestone goal, provider-optional deterministic local development constraint.
- `.planning/REQUIREMENTS.md` - OPS-01 through OPS-03 plus all 19 v2.5 requirements that Phase 37 must prove.
- `.planning/ROADMAP.md` - Phase 37 goal and success criteria.
- `.planning/STATE.md` - Current milestone state and out-of-scope boundaries.

### Required Prior Phase Context
- `.planning/phases/33-semantic-index-foundation/33-CONTEXT.md` - Semantic index source, chunk, fallback, provenance, and reindex decisions.
- `.planning/phases/33-semantic-index-foundation/33-01-SUMMARY.md` - Actual Phase 33 delivered schema/service/routes/tests.
- `.planning/phases/34-semantic-knowledge-search/34-CONTEXT.md` - Search result metadata, stale indicators, and contradiction status contract.
- `.planning/phases/34-semantic-knowledge-search/34-01-SUMMARY.md` - Actual Phase 34 search implementation and verification status.
- `.planning/phases/35-contradiction-review-workflow/35-CONTEXT.md` - Contradiction candidate/resolution decisions and freshness effects.
- `.planning/phases/35-contradiction-review-workflow/35-01-SUMMARY.md` - Actual Phase 35 delivered review workflow.
- `.planning/phases/36-jarvis-grounded-answers/36-CONTEXT.md` - Jarvis grounding decisions, citation target contract, and warning behavior.
- `.planning/phases/36-jarvis-grounded-answers/36-01-SUMMARY.md` - Actual Phase 36 delivered grounded answer behavior.

### Existing Code Evidence
- `server/src/services/rt2-semantic-index.ts` - Semantic index status, deterministic fallback embedding, run/chunk counts, stale chunks, provider mode.
- `server/src/routes/rt2-semantic-index.ts` - Existing company-scoped status and reindex route pattern.
- `packages/db/src/schema/rt2_v33_semantic_index.ts` - Semantic index chunk/run schema for health checks.
- `server/src/services/rt2-contradiction-review.ts` - Candidate generation/resolution and semantic freshness integration.
- `server/src/routes/rt2-contradiction-review.ts` - Existing contradiction review route pattern.
- `packages/db/src/schema/rt2_v33_contradiction_review.ts` - Candidate/resolution schema for operations checks.
- `server/src/services/rt2-jarvis.ts` - Grounding citations, warnings, and target metadata for Jarvis task advice.
- `server/src/routes/rt2-jarvis.ts` - Existing Jarvis route boundary and company access guard.
- `packages/shared/src/types/rt2-governance.ts` - Shared Jarvis grounding citation/warning contract.
- `packages/shared/src/types/rt2-knowledge.ts` - Shared contradiction and knowledge types.
- `ui/src/pages/rt2/KnowledgePage.tsx` - Existing semantic/search/bridge operator surface to extend with operations health.
- `ui/src/api/rt2-knowledge.ts` - Existing client patterns for RT2 knowledge APIs.
- `ui/src/lib/queryKeys.ts` - Query key conventions for health/status data.
- `server/src/__tests__/rt2-semantic-index.test.ts` - Existing deterministic semantic index route/service coverage.
- `server/src/__tests__/rt2-phase6-intelligence.test.ts` - Legacy intelligence/Jarvis/search coverage to preserve when adding operations checks.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `rt2SemanticIndexService.getStatus` already returns indexed chunks, source count, stale chunks, provider mode, embedding model, and last run details.
- `rt2SemanticIndexService.reindexCompany` records run mode, status, scanned sources, refreshed/skipped chunks, and errors.
- `rt2ContradictionReviewService` lists open/resolved candidates and marks semantic chunks stale/fresh as candidates open or resolve.
- `rt2JarvisService.getTaskAdvice` already returns grounding citations, warnings, retrieval count, and routable citation targets.
- `KnowledgePage` already displays semantic status/search and contradiction candidates, so Phase 37 can consolidate rather than create a new product surface.

### Established Patterns
- RT2 knowledge routes are company-scoped under `/companies/:companyId/rt2/...` and use `assertCompanyAccess`.
- v2.5 must stay provider-optional and deterministic for local development and CI.
- RT2 knowledge features are projection-backed and evidence-first; health should report missing evidence rather than silently healing it.
- Operator UI prefers compact status cards, filters, and evidence lists inside the RT2 shell.

### Integration Points
- Add a health aggregation service near existing RT2 knowledge/semantic services.
- Add a company-scoped route for semantic knowledge operations health.
- Add shared API response types and UI client/query keys for the health result.
- Extend `KnowledgePage` with an operations/health view that reuses semantic status, contradiction list, and Jarvis grounding warning signals.
- Add focused tests for health reason codes, company boundary, deterministic fallback, route response shape, and UI rendering of healthy/degraded/failed states.

</code_context>

<deferred>
## Deferred Ideas

- Cross-company semantic federation remains outside v2.5.
- Autonomous wiki/graph rewrite from health or contradiction patterns remains outside v2.5.
- Native mobile semantic operations are deferred until the web operator loop is stable.
- Mandatory live embedding or LLM provider integration remains out of scope.

</deferred>

---

*Phase: 37-knowledge-intelligence-operations*
*Context gathered: 2026-04-28*
