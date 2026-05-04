# Phase 81: wikiLLM/Graphify Knowledge Projection - Context

**Gathered:** 2026-05-04
**Status:** Ready for planning
**Mode:** auto (--auto --chain)

<domain>
## Phase Boundary

Phase 81 verifies RT2 knowledge projection for WIKI-01 (wikiLLM index.md/log.md/topic/project/schema export/update connected to RT2 event store), WIKI-02 (Graphify v3 corpus graph sidecar separation and completeness), and WIKI-03 (RT2-native operation with no Paperclip residue). This phase proves the Phase 68 wikiLLM living memory workflow and Phase 69 Graphify v3 corpus graph sidecar are correctly integrated and function as RT2-native knowledge surfaces. Phase 81 does not introduce new knowledge semantics — it verifies the integration end-to-end.

</domain>

<decisions>
## Implementation Decisions

### wikiLLM Living Memory — Export/Update Integration (WIKI-01, Phase 68 Carry-Forward)
- **D-01:** `rt2KnowledgeProjectorService.projectWikiForCompany` is the canonical materialization path. It reads RT2 domain events and produces `index.md`, `log.md`, topic/project/schema pages in `rt2V33WikiPages`. Phase 81 verifies this is the only wiki page materialization path.
- **D-02:** `Rt2WikiPageType` contract (`"index" | "log" | "topic" | "project" | "schema"`) is the canonical page type vocabulary. `projectWikiForCompany` must emit all five types. Phase 81 verifies the file layout matches Phase 68 decisions (`topics/<entityType>/<entityId>.md`, `projects/<projectId>.md`, `schemas/<entityType>.md`).
- **D-03:** Every wiki page update must preserve provenance via `sourceEventIds` and structured `Rt2WikiPageProvenance` metadata. Phase 81 verifies provenance is set on all materialization output.
- **D-04:** `Rt2WikiPageUpdateEvidence` shape (`reason`, `touchedPageKeys`, `sourceEventIds`, `sourceEventCount`, `relatedPageKeys`, `generatedAt`) is the canonical update evidence contract. Phase 81 verifies this contract is returned by materialization operations.
- **D-05:** Confidence vocabulary reuses `Rt2GraphConfidence` (`EXTRACTED`, `INFERRED`, `AMBIGUOUS`). Phase 81 verifies no duplicate confidence scheme exists for wiki pages.

### Graphify v3 Corpus Graph Sidecar — Integration and Completeness (WIKI-02, Phase 69 Carry-Forward)
- **D-06:** `rt2CorpusGraphService` (in `server/src/services/rt2-corpus-graph.ts`) owns all corpus graph operations. It is separate from `rt2_v33_graph_*` product graph tables. Phase 81 verifies this separation is maintained and the corpus graph is not conflated with product graph.
- **D-07:** `rt2CorpusGraphService.ingestSources` uses SHA256 cache for incremental ingest. Unchanged sources are reported as `skipped`. Phase 81 verifies this behavior works end-to-end.
- **D-08:** Deterministic extraction extracts: markdown headings (as `heading` nodes), code symbols (as `symbol` nodes), imports (as `term`/`imports` edges), and high-signal terms (as `term`/`mentions` edges). Phase 81 verifies the extraction interface is deterministic and provenance is preserved on every edge.
- **D-09:** Clustering uses `connected_components_fallback` algorithm. This is explicitly named as a fallback, not Leiden. Phase 81 verifies the algorithm produces community assignments and god nodes.
- **D-10:** Corpus graph query APIs exist: `getNode`, `getNeighbors`, `getCommunity`, `getGodNodes`, `getShortestPath`, `getStats`, `getReport`. Phase 81 verifies these routes are mounted and return typed responses.
- **D-11:** `buildMarkdownReport` in `rt2-corpus-graph.ts` produces a report with corpus/product graph node/edge counts and explicitly distinguishes the two graph types. Phase 81 verifies the report markdown says corpus graph and product graph are separate.

### wikiLLM ↔ Corpus Graph Integration Bridge
- **D-12:** wikiLLM export pages (`topics/`, `projects/`, `schemas/`) can serve as corpus graph source inputs. Phase 81 verifies the integration path exists: wiki page materialization → corpus graph source ingestion is wired or can be triggered.
- **D-13:** Phase 69 report explicitly says corpus graph and product graph are separate. Phase 81 verifies this boundary is documented in the report and not violated by downstream code.

### RT2-Native Operation — No Paperclip Residue (WIKI-03)
- **D-14:** All knowledge/graph services use `rt2-*` namespacing. No service named after Paperclip patterns (e.g., `WorkQueue`, `AgentTask`, `createIssue`) exists in knowledge/graph surfaces. Phase 81 scans for legacy patterns and confirms zero instances.
- **D-15:** `@paperclipai/*` package imports in knowledge/graph code are for schema/shared type compatibility only. Product-facing surfaces use RealTycoon2/Jarvis/knowledge terminology, not Paperclip engine names.
- **D-16:** `rt2KnowledgeProjectorService` is the canonical wiki projector. It emits domain events via `appendAndProject` for wiki mutations. Phase 81 verifies all wiki mutations go through this service.

### the agent's Discretion
- Exact route URL structure for wikiLLM ↔ corpus graph integration bridge — provided the integration path is wired and evidence is surfaced.
- Whether Phase 81 adds specific tests for provenance chain (RT2 event → wiki page → corpus graph source) or verifies existing tests cover this behavior.
- Exact UI placement for corpus graph report/evidence in knowledge surfaces — provided surfaces are visible and Korean-first.
- Exact stale threshold for corpus graph source re-ingest — provided it's explicit, tested, and recorded in evidence.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Milestone Truth
- `.planning/PROJECT.md` - v3.3 RT2 Engine Convergence goal, RealTycoon2-first identity, wikiLLM/Graphify boundary, Multica engine boundary.
- `.planning/REQUIREMENTS.md` - `WIKI-01`, `WIKI-02`, `WIKI-03`.
- `.planning/ROADMAP.md` - Phase 81 goal, success criteria, v3.3 dependency chain (Phase 78 → 79 → 80 → 81 → 84).
- `.planning/STATE.md` - Phase 81 current position.
- `.planning/phases/80-work-lifecycle-integration/80-CONTEXT.md` - Phase 80 verification confirming RT2-01/02/03.
- `.planning/phases/68-wikillm-living-memory-workflow/68-CONTEXT.md` - Phase 68 wikiLLM decisions (file model, provenance, Jarvis citation/draft loop).
- `.planning/phases/69-graphify-v3-corpus-graph-sidecar/69-CONTEXT.md` - Phase 69 corpus graph decisions (separation, SHA256 cache, extraction, clustering, query APIs).

### Prior Phase Context (Phase 67/68/69)
- `.planning/phases/67-multica-runtime-execution-alignment/67-CONTEXT.md` - Phase 67 runtime alignment (queue state machine, runtime-aware dispatch, heartbeat/cancellation/cleanup).
- `.planning/phases/68-wikillm-living-memory-workflow/68-CONTEXT.md` - Phase 68 wikiLLM living memory decisions.
- `.planning/phases/68-wikillm-living-memory-workflow/68-01-PLAN.md` - Phase 68 plan.
- `.planning/phases/69-graphify-v3-corpus-graph-sidecar/69-CONTEXT.md` - Phase 69 corpus graph decisions.
- `.planning/phases/69-graphify-v3-corpus-graph-sidecar/69-01-PLAN.md` - Phase 69 plan.
- `.planning/phases/69-graphify-v3-corpus-graph-sidecar/69-VERIFICATION.md` - Phase 69 verification evidence.

### wikiLLM Knowledge Code
- `packages/db/src/schema/rt2_v33_wiki_pages.ts` - Wiki page schema (`pageKey`, `pageType`, `sourceEventIds`, `metadata`).
- `packages/shared/src/types/rt2-knowledge.ts` - `Rt2WikiPageType`, `Rt2WikiPageProvenance`, `Rt2WikiPageUpdateEvidence` contracts.
- `packages/shared/src/validators/rt2-knowledge.ts` - Wiki page validators.
- `server/src/services/rt2-knowledge-projector.ts` - Main wiki/graph projector with `projectWikiForCompany`, vault export/import, daily wiki materialization.
- `server/src/routes/rt2-knowledge.ts` - wiki/vault/bridge/daily knowledge routes.
- `server/src/services/rt2-jarvis.ts` - Jarvis citation and rewrite proposal paths.
- `ui/src/pages/rt2/KnowledgePage.tsx` - Main knowledge/search/wiki/graph/bridge/operations surface.
- `ui/src/components/Rt2DailyWikiPanel.tsx` - Daily wiki rendering surface.

### Corpus Graph Code
- `packages/db/src/schema/rt2_v33_corpus_graph_sources.ts` - Corpus graph sources table (if exists, check via imports in rt2-corpus-graph.ts).
- `packages/db/src/schema/rt2_v33_graph_projection.ts` - Product graph schema (separate from corpus graph).
- `packages/shared/src/types/rt2-graph.ts` - `Rt2CorpusGraphSourceType`, `Rt2CorpusGraphNodeType`, `Rt2CorpusGraphEdgeType`, `Rt2CorpusGraph*` contracts.
- `packages/shared/src/validators/rt2-graph.ts` - Corpus graph validators.
- `server/src/services/rt2-corpus-graph.ts` - Full corpus graph implementation (1049 lines): ingest, extract, clustering, query, report.
- `server/src/routes/rt2-corpus-graph.ts` - Corpus graph routes mounted at `/companies/:companyId/rt2/corpus-graph/*`.
- `server/src/__tests__/rt2-corpus-graph.test.ts` - Corpus graph tests.

### Engine Reference
- `.planning/research/ENGINE-REFERENCE-AUDIT.md` - Canonical Graphify v3 sidecar reference, wikiLLM/Multica engine boundaries, RT2 gap statement.
- `_refs/graphify-v3/ARCHITECTURE.md` - Upstream pipeline reference (Phase 69 external boundary).

</canonical_refs>

<codebase>
## Existing Code Insights

### Reusable Assets
- `rt2KnowledgeProjectorService.projectWikiForCompany` already materializes `index.md`, `log.md`, and topic pages from RT2 domain events.
- `rt2CorpusGraphService` already has complete implementation: ingest with SHA256 cache, deterministic extraction (headings/symbols/imports/terms), connected-components clustering, query APIs, and markdown report generation.
- `Rt2WikiPageType` enum already supports `"index" | "log" | "topic" | "project" | "schema"` — five page types matching Phase 68 decisions.
- `Rt2GraphConfidence` (`EXTRACTED`, `INFERRED`, `AMBIGUOUS`) is shared between wiki confidence and corpus graph confidence.
- Phase 68 already has provenance (`Rt2WikiPageProvenance`) and update evidence (`Rt2WikiPageUpdateEvidence`) contracts.

### Established Patterns
- RT2 knowledge is event-first projected. Wiki pages are materialization output, not canonical source.
- Corpus graph is separate from product graph. Phase 69 explicitly warns against conflation.
- Confidence vocabulary is unified: `EXTRACTED`, `INFERRED`, `AMBIGUOUS` across wiki and corpus graph.
- SHA256 incremental cache is the standard for corpus source ingestion.
- `connected_components_fallback` clustering is explicitly named as a fallback (not Leiden).
- Product-facing copy is Korean-first. Engine names stay in reference/internal boundaries.

### Integration Points
- wikiLLM materialization → corpus graph: Phase 68 wikiLLM export pages can feed Phase 69 corpus graph source ingestion (needs Phase 81 verification of whether this bridge is wired).
- RT2 domain events → wiki page materialization → corpus graph source → query/report is the end-to-end knowledge flow.
- Jarvis citation/draft loop connects wiki pages to task advice and rewrite proposals.

</codebase>

<specifics>
## Specific Ideas

- Phase 81 WIKI-01 verification: prove the Phase 68 wikiLLM living memory workflow is complete — file model export (index/log/topic/project/schema), provenance/confidence/contradiction update evidence, and Jarvis citation/draft loop.
- Phase 81 WIKI-02 verification: prove the Phase 69 Graphify v3 corpus graph sidecar is complete and separate from product graph — source ingest (SHA256), deterministic extraction, clustering, query APIs, report with explicit product/corpus boundary statement.
- Phase 81 WIKI-03 verification: prove RT2-native operation — all knowledge/graph services use `rt2-*` namespacing, no Paperclip legacy patterns in wikiLLM/Graphify surfaces.
- Key integration question: Does wikiLLM export materialization feed into corpus graph source ingestion? If not, Phase 81 should verify whether this bridge is needed or out of scope.
- WIKI-03 also covers CLEANUP-01/02/03 partial scope: Phase 81 verifies no Paperclip residue in wikiLLM/Graphify code, but full CLEANUP residue removal is Phase 82/83.

</specifics>

<deferred>
## Deferred Ideas

- CLEANUP-01/02/03 (Paperclip residue full cleanup) is Phase 82 scope — Phase 81 focuses on WIKI-01/02/03, not full residue removal.
- RT2-03 (Paperclip legacy cleanup for execution) is Phase 83 scope.
- Full daemon import or remote worker marketplace remains future scope.
- Graph MCP server exposure is future scope unless Phase 81 plan determines it's within scope.
- UI visualization for corpus graph is future scope — Phase 81 completion is API/report/evidence-first.

</deferred>

---

*Phase: 81-wikillm-graphify-knowledge-projection*
*Context gathered: 2026-05-04*
*Mode: auto (--auto --chain)*
