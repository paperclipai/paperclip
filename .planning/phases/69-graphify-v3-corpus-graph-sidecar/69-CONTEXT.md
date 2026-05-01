# Phase 69: Graphify v3 Corpus Graph Sidecar - Context

**Gathered:** 2026-05-01
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 69 implements a Graphify v3-style corpus graph sidecar for RealTycoon2. The sidecar ingests repo/docs/wiki source files with SHA256 cache and source-location metadata, extracts code/docs relationships with confidence and provenance, exposes graph query APIs, and generates a report that explicitly distinguishes the new corpus graph from the existing RT2 product graph.

This phase must not replace the existing RT2 product graph, Task Mesh, wikiLLM living memory, Jarvis approval workflow, or Phase 70 economy loop. The existing product graph remains a company/product event projection. The new sidecar is an agent-readable corpus memory over files and wiki pages.

</domain>

<decisions>
## Implementation Decisions

### Corpus Graph Boundary
- **D-01:** Add separate corpus graph persistence instead of widening the existing project-scoped `rt2_v33_graph_*` tables. Existing product graph rows are project/work evidence; Phase 69 sidecar rows are company-scoped corpus memory.
- **D-02:** Keep Graphify terminology mostly in planning/docs/API internals. Operator-facing copy, if touched, remains RealTycoon2/Jarvis/knowledge oriented.
- **D-03:** Treat upstream Graphify v3 as a reference contract, not a vendored dependency. Do not import upstream code wholesale.

### Source Ingest And Cache
- **D-04:** Ingest accepts repo, docs, and wiki source files through a typed service/route contract. Each source stores `sourceKey`, `sourceType`, `sourceLocation`, SHA256, title, metadata, and last ingest timestamp.
- **D-05:** SHA256 cache is the incremental boundary. Unchanged sources are reported as `skipped`; changed sources are re-extracted and replace only their own corpus nodes/edges.
- **D-06:** Source locations must preserve file path, optional URL, and line-span metadata for extracted nodes/edges so downstream agents can trace graph facts back to corpus text.

### Extraction And Provenance
- **D-07:** Implement deterministic code/docs extraction first: markdown headings/wiki links, code import/export/function/class/const symbols, and high-signal corpus terms. This is the Phase 69 extraction interface; planner may later swap in tree-sitter/provider extraction behind the same contract.
- **D-08:** Every corpus edge carries relation type, rationale, confidence label (`EXTRACTED`, `INFERRED`, `AMBIGUOUS`), numeric confidence score, and provenance evidence. No relation without provenance should be counted as complete.
- **D-09:** Cross-source inferred edges should be conservative: shared high-signal terms or explicit links only. Ambiguous/low-confidence relations must remain visibly marked, not silently treated as facts.

### Query And Clustering API
- **D-10:** Add APIs for `node`, `neighbors`, `community`, `shortest path`, `god nodes`, and `graph stats`. These APIs should be company-scoped and should not require a `projectId`.
- **D-11:** Use a deterministic connected-component/label-propagation fallback clustering algorithm and name it explicitly as a fallback. Do not call it Leiden unless a real Leiden implementation is present.
- **D-12:** Shortest path uses the persisted corpus graph and returns ordered nodes/edges plus a clear empty result when no path exists.

### Corpus Report
- **D-13:** Add a corpus graph report that includes corpus node/edge counts, product graph counts, confidence summary, community count, god nodes, knowledge gaps, surprising connections, and suggested questions.
- **D-14:** The report must explicitly say that product graph and corpus graph are separate. This prevents Phase 69 from overclaiming earlier Task Mesh/product graph evidence as Graphify v3 parity.
- **D-15:** Knowledge gaps should be generated from thin sources, isolated nodes, ambiguous edges, and missing cross-source links. Suggested questions should be derived from gaps/god nodes rather than generic filler.

### DevPlan Alignment And Verification
- **D-16:** Update `scripts/rt2-devplan-alignment-gate.mjs` so `graphify-v3-sidecar` becomes `complete` only after shared contracts, corpus graph DB schema, service/route query APIs, report generation, focused tests, and engine reference evidence exist.
- **D-17:** Focused verification should include shared graph contract tests, corpus graph service tests, route tests, alignment gate tests, `pnpm typecheck`, and `pnpm test`.
- **D-18:** Do not run `pnpm test:e2e` as the default Phase 69 gate.

### the agent's Discretion
- Exact table/field names, provided product graph and corpus graph remain separate and typed.
- Exact high-signal term extraction heuristics, provided tests prove deterministic extraction and provenance.
- Whether route URLs live under `rt2/graph` or `rt2/corpus-graph`, provided product graph APIs remain backward-compatible.
- Exact report markdown wording, provided it distinguishes graph types and lists gaps/questions.

</decisions>

<specifics>
## Specific Ideas

- Recommended source types: `repo_file`, `doc_file`, `wiki_page`, `external_reference`.
- Recommended node types: `source_file`, `heading`, `symbol`, `term`.
- Recommended edge types: `contains`, `imports`, `references`, `mentions`, `shared_concept`.
- Recommended route family: `/companies/:companyId/rt2/corpus-graph/*`.
- Recommended report title: `# Corpus Graph Sidecar Report`, with a boundary section for product graph vs corpus graph.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Milestone Truth
- `AGENTS.md` - Korean-first workflow, RealTycoon2 terminology, verification command policy, lockfile policy, and no-overplanning guidance.
- `.planning/PROJECT.md` - v3.1 DevPlan Core Convergence goal, Graphify/product graph separation decision, and brownfield constraints.
- `.planning/REQUIREMENTS.md` - `GRAPH-01`, `GRAPH-02`, `GRAPH-03`, and `GRAPH-04`.
- `.planning/ROADMAP.md` - Phase 69 goal, success criteria, and dependency on Phase 68.
- `.planning/STATE.md` - Current position and next-session instruction.
- `.planning/phases/65-devplan-truth-and-identity-cleanup/65-CONTEXT.md` - Evidence-backed completion and engine parity claim rules.
- `.planning/phases/68-wikillm-living-memory-workflow/68-CONTEXT.md` - wikiLLM file/source boundary and deferred Phase 69 ownership.

### Graphify Reference Boundary
- `.planning/research/ENGINE-REFERENCE-AUDIT.md` - Canonical Graphify v3 sidecar reference and current RT2 gap statement.
- `_refs/graphify-v3/ARCHITECTURE.md` - Upstream pipeline reference: detect -> extract -> build graph -> cluster -> analyze -> report -> query.
- `_refs/graphify-v3/graphify/extract.py` - Extraction interface reference.
- `_refs/graphify-v3/graphify/cache.py` - File SHA cache reference.
- `_refs/graphify-v3/graphify/build.py` - Graph assembly reference.
- `_refs/graphify-v3/graphify/cluster.py` - Clustering reference and fallback boundary.
- `_refs/graphify-v3/graphify/analyze.py` - God nodes, gaps, surprising connection reference.
- `_refs/graphify-v3/graphify/report.py` - Graph report reference.
- `_refs/graphify-v3/graphify/serve.py` - Query/MCP endpoint reference.

### Existing RT2 Code And Tests
- `packages/db/src/schema/rt2_v33_graph_projection.ts` - Existing product graph schema; do not conflate with corpus graph sidecar.
- `packages/shared/src/types/rt2-graph.ts` - Current graph confidence vocabulary and product graph contracts to extend carefully.
- `packages/shared/src/validators/rt2-graph.ts` - Existing graph validators to extend with corpus graph query/ingest schemas.
- `server/src/services/rt2-task-mesh.ts` - Existing product graph algorithms and report concepts.
- `server/src/routes/rt2-task-mesh.ts` - Current product graph routes.
- `server/src/services/rt2-knowledge-projector.ts` - wikiLLM export/source pages and current product graph projector.
- `server/src/routes/rt2-knowledge.ts` - Existing knowledge/wiki route patterns.
- `server/src/__tests__/rt2-knowledge-projector.test.ts` - Existing embedded Postgres projector test pattern.
- `server/src/__tests__/rt2-knowledge-routes.test.ts` - Existing route test pattern.
- `scripts/rt2-devplan-alignment-gate.mjs` - v3.1 completion truth gate to update after implementation.
- `scripts/rt2-devplan-alignment-gate.test.mjs` - Focused alignment gate tests.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Existing product graph schema already has node/edge/cache/community/report concepts, but it is project-scoped and should remain product graph evidence.
- `Rt2GraphConfidence` already provides the `EXTRACTED`, `INFERRED`, and `AMBIGUOUS` vocabulary needed for corpus relation provenance.
- `rt2TaskMeshService` already has degree centrality, god node, surprising connection, and markdown report ideas that can be reused conceptually.
- Phase 68 wikiLLM export provides wiki pages as file-like sources that can feed the new corpus sidecar.

### Established Patterns
- Completion claims require concrete code/schema/route/test evidence and the engine reference audit.
- Focused Vitest service/route/script tests are accepted evidence on this Windows host.
- Product-facing identity remains RealTycoon2-first; engine names stay in reference/internal boundaries.
- Event/wiki projectors are canonical for product memory; corpus graph sidecar is separate from those product projections.

### Integration Points
- Add shared corpus graph types/validators in `packages/shared/src/types/rt2-graph.ts` and `packages/shared/src/validators/rt2-graph.ts`.
- Add DB schema and migration for corpus graph sources/nodes/edges/communities/reports.
- Add `server/src/services/rt2-corpus-graph.ts` for ingest, extraction, clustering, query, shortest path, and report generation.
- Add `server/src/routes/rt2-corpus-graph.ts` and mount it in `server/src/app.ts`.
- Add focused service/route tests and update the DevPlan alignment gate only after tests exist.

</code_context>

<deferred>
## Deferred Ideas

- Real tree-sitter integration and provider-assisted semantic extraction can replace the deterministic extractor in a future hardening phase.
- Graph MCP server exposure is future scope unless it fits after the core route/query contract is complete.
- Neo4j/graph.json/graph.html exports are future parity hardening, not required for Phase 69 completion.
- UI visualization for the corpus sidecar can be added later; Phase 69 completion is API/report/evidence-first.
- Phase 70 economy/P&L/CareerMate and Phase 71 final acceptance gate remain out of scope.

</deferred>

---

*Phase: 69-graphify-v3-corpus-graph-sidecar*
*Context gathered: 2026-05-01*
