# Phase 33: Semantic Index Foundation - Context

**Gathered:** 2026-04-28
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 33 adds a company-scoped, embedding-ready semantic index layer over existing RT2 daily wiki, graph, and work artifact evidence. It must not replace existing wiki, graph, projector, or lexical/hybrid search storage. This phase owns index schema, indexing service, deterministic local embedding fallback, source freshness/provenance tracking, and an operator-triggerable incremental reindex/status API. Search UX, contradiction review, Jarvis answer grounding, and operations dashboards belong to later phases.

</domain>

<decisions>
## Implementation Decisions

### Index Storage Boundary
- **D-01:** Add a new RT2 semantic index schema rather than mutating `rt2_v33_daily_wiki_pages`, `rt2_v33_graph_nodes`, `rt2_v33_graph_edges`, `issue_work_products`, or the existing `rt2_search_index` metadata table into the source of truth.
- **D-02:** Every indexed row must be company-scoped and carry stable `sourceType`, `sourceId`, optional `projectId`, `sourceUpdatedAt`, `freshness`, `contentHash`, and projector/provenance metadata.
- **D-03:** Store chunk-level content, not only whole-source rows. The initial chunking can be deterministic and simple, but each chunk needs a stable key/hash so unchanged chunks are not re-embedded.
- **D-04:** The foundation should be pgvector-ready without making pgvector mandatory for local dev. If vector columns are introduced, planning must include a deterministic non-vector code path for PGlite/tests.

### Source Ingestion Scope
- **D-05:** Initial sources are exactly the Phase 33 requirement set: daily wiki pages, graph nodes/edges, and work artifacts/deliverables. Do not add cross-company federation, Jarvis answer composition, or contradiction candidates in this phase.
- **D-06:** Daily wiki indexing should use `rt2_v33_daily_wiki_pages` fields: `id`, `companyId`, `projectId`, `userId`, `reportDate`, `pageKey`, `shortSummary`, `markdown`, `history`, `sourceEventIds`, and `updatedAt`.
- **D-07:** Graph indexing should use persisted graph projection rows, preserving node/edge confidence and evidence. Graph nodes and graph edges should be indexed as distinct source types so later phases can cite them precisely.
- **D-08:** Work artifact indexing should use `issue_work_products` and preserve issue/project linkage, provider/external ID, title, summary, status, review state, health status, and metadata.

### Embedding Provider and Fallback
- **D-09:** Implement embedding through an injectable provider interface with two modes: provider-backed embeddings when configured, and deterministic local fallback when not configured.
- **D-10:** The fallback must be stable across test runs and machines. It can use normalized token hashing or another deterministic algorithm, but must not call a network provider, depend on secrets, or require pgvector.
- **D-11:** Tests should assert fallback determinism, company boundary, source provenance preservation, and changed-source refresh behavior before any live provider behavior is trusted.
- **D-12:** Provider configuration should stay optional for Phase 33. Missing provider credentials should degrade to fallback mode, not fail indexing or tests.

### Incremental Reindex Operation
- **D-13:** Add a reindex service that can run full company reindex and changed-source refresh. Changed-source detection should start from source `updatedAt`, source event IDs, content hash, or graph cache/source evidence where available.
- **D-14:** Reindex runs must be inspectable: status, started/completed timestamps, mode, provider/fallback mode, sources scanned, chunks refreshed, chunks skipped, and last error if failed.
- **D-15:** The API surface should align with the existing RT2 route pattern under `/companies/:companyId/rt2/...` and must use `assertCompanyAccess`.
- **D-16:** Existing `/rt2/search` behavior can remain lexical/hybrid for now. Phase 33 may expose semantic index status/reindex endpoints, but semantic ranking/search result UI belongs to Phase 34.

### the agent's Discretion
- Exact table names, chunk size, hash algorithm, and provider interface names are planner discretion as long as the source/provenance/fallback requirements above are preserved.
- The planner may reuse the existing `rt2SearchIndex` table for high-level status only if it does not blur the semantic index rows with legacy keyword/hybrid metadata.
- The operator-facing status surface can start as an API response and focused tests; a richer UI dashboard is Phase 37 unless a minimal status view is needed to satisfy SEM-04 honestly.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product and Phase Scope
- `.planning/PROJECT.md` - RT2-first identity, v2.5 semantic knowledge intelligence goal, and provider-optional local development constraint.
- `.planning/REQUIREMENTS.md` - SEM-01 through SEM-04 are the locked Phase 33 requirements.
- `.planning/ROADMAP.md` - Phase 33 goal and success criteria.
- `.planning/STATE.md` - Current milestone state and v2.5 deferred/out-of-scope boundaries.

### Prior Knowledge Decisions
- `.planning/phases/30-knowledge-artifact-and-verification-closure/30-CONTEXT.md` - Daily wiki and graph projection evidence anchors.
- `.planning/phases/32-lint-traceability-and-milestone-acceptance-closure/32-CONTEXT.md` - Deterministic semantic-like linting precedent and evidence standards.
- `.planning/phases/25-daily-wiki-projector/25-CONTEXT.md` - Daily wiki source-event and page-key decisions.
- `.planning/phases/26-graphify-projector/26-CONTEXT.md` - Graph cache, confidence, node/edge, and report decisions.
- `.planning/phases/06-jarvis-quality-and-hybrid-search/06-CONTEXT.md` - Existing RT2 grounding/search source set: tasks, deliverables, wiki, graph, and quality evidence.

### Existing Code Evidence
- `packages/db/src/schema/rt2_v33_daily_wiki_pages.ts` - Daily wiki source table with company/project/date/pageKey/sourceEventIds/update metadata.
- `packages/db/src/schema/rt2_v33_graph_projection.ts` - Graph nodes, edges, cache, communities, reports, confidence, and evidence fields.
- `packages/db/src/schema/issue_work_products.ts` - Work artifact/deliverable evidence source.
- `packages/db/src/schema/rt2_search.ts` - Existing search metadata/log tables; useful pattern but not enough for semantic index rows.
- `packages/db/src/schema/index.ts` - Schema export pattern for new RT2 tables.
- `server/src/services/rt2-hybrid-search.ts` - Existing lexical/hybrid search service and reindex/status precedent.
- `server/src/routes/rt2-hybrid-search.ts` - Existing `/companies/:companyId/rt2/search`, `/stats`, and `/reindex` route style with company access check.
- `server/src/services/rt2-knowledge-projector.ts` - Daily wiki, graph projection, graph cache, sourceEventIds, and confidence/evidence materialization.
- `server/src/services/rt2-wiki-lint.ts` - Deterministic semantic-comparison precedent used without provider dependency.

### Test Evidence Targets
- `server/src/__tests__/rt2-knowledge-projector.test.ts` - Existing source projection tests to mirror for semantic index source ingestion.
- `server/src/__tests__/rt2-wiki-lint.test.ts` - Deterministic semantic comparison/fallback precedent.
- `server/src/__tests__/rt2-knowledge-routes.test.ts` - Existing RT2 knowledge route patterns and company-scoped route testing.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `rt2V33DailyWikiPages` already stores company/project/user/date/pageKey/markdown/history/sourceEventIds/updatedAt, enough to build deterministic daily wiki chunks and freshness checks.
- `rt2V33GraphNodes` and `rt2V33GraphEdges` already preserve `sourceId`, node type, confidence, rationale, evidence, centrality, and `updatedAt`, which should become semantic index provenance.
- `issueWorkProducts` already provides work artifact identity, title, summary, status, review state, health status, provider/external ID, and metadata.
- `rt2HybridSearchService.getSearchStats()` and `rebuildIndex()` provide an existing service shape for status/reindex operations, but its current behavior is metadata/lexical, not a true semantic index.
- `rt2WikiLintService` shows a provider-free deterministic comparison pattern that can inspire fallback tests.

### Established Patterns
- RT2 source data remains company-scoped and projector-backed; derived indexes should be rebuildable from source tables.
- Existing RT2 routes use `/companies/:companyId/rt2/...` plus `assertCompanyAccess`.
- Knowledge features must preserve evidence/provenance and avoid treating derived graph/search rows as authoritative business truth.
- Local dev and CI must keep passing without live provider credentials, external Postgres, or mandatory pgvector.

### Integration Points
- New DB schema should live under `packages/db/src/schema/` with migration under `packages/db/src/migrations/` and export through `packages/db/src/schema/index.ts`.
- New server logic should likely live as an RT2 service plus route adjacent to `rt2-hybrid-search.ts` or a dedicated semantic-index service/route.
- Reindex should read daily wiki, graph node/edge, and work product rows through Drizzle and produce semantic index rows plus run/status records.
- Phase 34 semantic search should later consume these rows, so Phase 33 should expose clean queryable metadata even if it does not implement final search UX.

</code_context>

<specifics>
## Specific Ideas

- Prefer source type labels that future phases can filter/cite directly, such as `daily_wiki_page`, `graph_node`, `graph_edge`, and `work_artifact`.
- Preserve source freshness explicitly rather than inferring it only from vector row timestamps.
- Treat `contentHash` and chunk key as the primary incremental skip mechanism.
- Keep provider mode visible in run status so operators can tell whether a run used live embeddings or deterministic fallback.

</specifics>

<deferred>
## Deferred Ideas

- Semantic result ranking, lexical fallback combination, filters, and search UI are Phase 34.
- Contradiction candidate creation and review workflow are Phase 35.
- Jarvis cited answer grounding and contradiction warnings are Phase 36.
- Knowledge health dashboard and milestone-level semantic/contradiction/Jarvis gates are Phase 37.
- Cross-company semantic federation and automatic wiki rewrites remain outside v2.5.

</deferred>

---

*Phase: 33-semantic-index-foundation*
*Context gathered: 2026-04-28*
