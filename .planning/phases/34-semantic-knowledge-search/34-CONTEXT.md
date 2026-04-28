# Phase 34: Semantic Knowledge Search - Context

**Gathered:** 2026-04-28
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 34 turns the Phase 33 semantic index foundation into an operator-facing company-scoped knowledge search experience. It must let operators search RT2 daily wiki, graph evidence, work artifacts, and deliverables from one surface, combine semantic ranking with lexical fallback, show provenance/freshness/confidence metadata, and expose filters required by SEARCH-01 through SEARCH-04. It should not create contradiction candidates, rewrite knowledge, ground Jarvis answers, or build the full knowledge operations dashboard; those belong to Phases 35-37.

</domain>

<decisions>
## Implementation Decisions

### Search API Shape
- **D-01:** Extend or replace the current `/companies/:companyId/rt2/search` implementation so Phase 34 search reads Phase 33 semantic index chunks and still preserves lexical fallback. Do not create a parallel operator search endpoint unless compatibility requires a thin adapter.
- **D-02:** The response must distinguish ranking evidence sources: semantic chunk similarity, lexical match, and deterministic fallback scoring. Existing `searchType: "hybrid"` can remain, but result evidence must stop implying semantic rerank when only domain weighting was used.
- **D-03:** Search remains strictly company-scoped through `assertCompanyAccess` and `companyId` filters on both semantic chunks and fallback source queries.
- **D-04:** Empty or missing query behavior should stay explicit and route-testable: return a clear 400 for missing `q`, and avoid returning company-wide knowledge by accident.

### Ranking and Fallback
- **D-05:** Use Phase 33 chunk embeddings as the primary semantic input when indexed chunks exist. Query embedding should use the same provider interface/fallback model as Phase 33 so local dev and CI remain deterministic.
- **D-06:** Local dev must not require pgvector. Compute deterministic similarity in application code over stored JSON vectors when pgvector/vector SQL is unavailable.
- **D-07:** Lexical fallback should continue searching source tables directly for wiki/task/deliverable/graph matches so useful results still appear before a company has run semantic reindex.
- **D-08:** Ranking should blend semantic similarity, lexical score, source freshness, source confidence where available, and source-type weighting. Planner can tune exact weights, but semantic similarity and lexical evidence must both be visible in result metadata.

### Result Contract
- **D-09:** Result types should align with Phase 33 source types and existing operator vocabulary: `daily_wiki_page`, `graph_node`, `graph_edge`, `work_artifact`/`deliverable`, and task/work object references where lexical fallback finds task rows.
- **D-10:** Every result must include source type, source ID/key, title/label, evidence snippet or matched chunk text, score, updated/source date, freshness indicator, and provenance metadata sufficient to open or cite the source later.
- **D-11:** Confidence should be surfaced from graph edge/node provenance when present. Sources without native confidence should use a neutral/unknown confidence value rather than inventing certainty.
- **D-12:** Contradiction status filter and badges are required by SEARCH-03, but Phase 34 should model them as `none`/`unknown` placeholders or metadata joins if existing lint evidence is available. It must not implement Phase 35 contradiction candidate creation.

### Filters and Operator Surface
- **D-13:** Provide filters for project/work object, date range, source type, confidence, and contradiction status in both API query parameters and UI state.
- **D-14:** The first UI surface should live in the existing `KnowledgePage` route as a new search-focused view/tab rather than a new disconnected page.
- **D-15:** The search UI should be company-wide by default, with optional project narrowing. It must not force the current project selector to hide company-wide knowledge results.
- **D-16:** Result cards should be dense and evidence-forward: title, source badge, snippet, score/evidence chips, freshness/staleness, and an open-source affordance. Avoid marketing-style explanation blocks.

### Compatibility and Migration
- **D-17:** Preserve existing Phase 6 `/rt2/search` tests by updating expectations to the new honest semantic/lexical contract rather than deleting legacy coverage.
- **D-18:** Reuse `rt2SemanticIndexService` where possible. If query embedding/search helpers are added, they should live adjacent to Phase 33 service code and share deterministic embedding behavior.
- **D-19:** Do not mutate Phase 33 index schema unless a small additive field is required for search filters. Prefer deriving result metadata from existing chunk provenance and source tables.
- **D-20:** Phase 34 verification must include route tests for filters, deterministic semantic ranking without pgvector, lexical fallback when no semantic chunks exist, and UI/component tests for result metadata and filters.

### the agent's Discretion
- Exact ranking weights, default result limit, debounce interval, and snippet extraction logic are planner discretion as long as deterministic tests prove ordering and fallback behavior.
- The planner may choose whether to keep the service name `rt2HybridSearchService` or introduce `rt2SemanticKnowledgeSearchService`, but product-facing labels should say semantic knowledge search rather than legacy hybrid-only search.
- The UI can start as a focused tab inside `KnowledgePage`; a broader operations dashboard remains Phase 37.

</decisions>

<specifics>
## Specific Ideas

- Search should feel like an operator investigation tool: query first, filters nearby, results optimized for scanning evidence and freshness.
- Use Phase 33 source labels directly where possible: `daily_wiki_page`, `graph_node`, `graph_edge`, `work_artifact`.
- When semantic index is empty or stale, the UI should still show lexical fallback results and a compact stale/index status hint, not a blocking empty state.
- Contradiction status should be present in the filter/result contract now so Phase 35 can fill it without reshaping the search API later.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product and Phase Scope
- `.planning/PROJECT.md` - RT2-first identity, v2.5 semantic knowledge intelligence goal, and provider-optional local development constraint.
- `.planning/REQUIREMENTS.md` - SEARCH-01 through SEARCH-04 are the locked Phase 34 requirements.
- `.planning/ROADMAP.md` - Phase 34 goal and success criteria.
- `.planning/STATE.md` - Current milestone state and v2.5 deferred/out-of-scope boundaries.

### Required Prior Phase Context
- `.planning/phases/33-semantic-index-foundation/33-CONTEXT.md` - Semantic index source, chunk, fallback, provenance, and reindex decisions that Phase 34 consumes.
- `.planning/phases/33-semantic-index-foundation/33-01-SUMMARY.md` - Actual Phase 33 delivered endpoints, schema, service, and verification status.
- `.planning/phases/06-jarvis-quality-and-hybrid-search/06-CONTEXT.md` - Legacy hybrid search and evidence-backed Jarvis/search source expectations.
- `.planning/phases/32-lint-traceability-and-milestone-acceptance-closure/32-CONTEXT.md` - Evidence-only linting and `embedding_consistency` precedent relevant to contradiction placeholders.

### Existing Code Evidence
- `packages/db/src/schema/rt2_v33_semantic_index.ts` - Phase 33 semantic chunk/run tables, source types, vectors, freshness, provenance.
- `server/src/services/rt2-semantic-index.ts` - Deterministic embedding fallback, source collection, chunking, and reindex/status behavior.
- `server/src/routes/rt2-semantic-index.ts` - Existing semantic index status/reindex route style and company access guard.
- `server/src/services/rt2-hybrid-search.ts` - Existing lexical/hybrid search service to replace or adapt.
- `server/src/routes/rt2-hybrid-search.ts` - Existing `/companies/:companyId/rt2/search` API contract.
- `ui/src/pages/rt2/KnowledgePage.tsx` - Existing operator knowledge route where the search view should be added.
- `ui/src/api/rt2-knowledge.ts` - Existing RT2 knowledge API client patterns.
- `ui/src/lib/queryKeys.ts` - Query key conventions for adding semantic search/status queries.
- `server/src/__tests__/rt2-semantic-index.test.ts` - Phase 33 deterministic embedding and source indexing tests to reuse for search setup.
- `server/src/__tests__/rt2-phase6-intelligence.test.ts` - Legacy hybrid search route expectations that should be updated, not discarded.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `rt2V33SemanticIndexChunks` stores company/project/source identifiers, chunk text, JSON embedding vectors, embedding provider/model, freshness, sourceUpdatedAt, and provenance. This is the primary semantic search input.
- `deterministicSemanticEmbedding` in `server/src/services/rt2-semantic-index.ts` already provides stable query/source vectors for provider-free tests.
- `rt2HybridSearchService` already returns ranked results and logs search calls, but its current semantic claim is only type weighting; Phase 34 should make this real or rename evidence honestly.
- `KnowledgePage` already owns daily/wiki/graph/bridge tabs and company/project context; it is the right place for the first operator search tab.
- Existing route pattern uses `/companies/:companyId/rt2/...` plus `assertCompanyAccess`, matching the Phase 34 API requirement.

### Established Patterns
- RT2 knowledge features are derived and rebuildable; source tables remain authoritative.
- Operator routes prefer compact API surfaces with route-level access checks and focused Vitest coverage.
- UI data fetching uses `@tanstack/react-query`, local API modules, and query key helpers.
- Local verification must pass without live providers, external Postgres, mandatory pgvector, or network calls.

### Integration Points
- Add semantic search helpers near `rt2-semantic-index.ts` or refactor `rt2-hybrid-search.ts` to consume semantic chunks.
- Add or update `/companies/:companyId/rt2/search` query params for project/work object, date range, source type, confidence, contradiction status, limit, and offset.
- Add API client/query keys for semantic knowledge search and semantic index status in the UI.
- Add a `KnowledgePage` search tab with filter state, query input, result list, fallback/status hints, and source-open links where existing routes allow.

</code_context>

<deferred>
## Deferred Ideas

- Provider-backed live embedding adapter wiring remains optional unless already available; Phase 34 must work with deterministic fallback.
- Contradiction candidate creation, review decisions, and audit trail are Phase 35.
- Jarvis answer composition with citations and contradiction warnings is Phase 36.
- Full semantic/contradiction/Jarvis health dashboard and milestone health gate are Phase 37.
- Cross-company semantic federation and autonomous knowledge rewrites remain outside v2.5.

</deferred>

---

*Phase: 34-semantic-knowledge-search*
*Context gathered: 2026-04-28*
