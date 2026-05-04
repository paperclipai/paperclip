# Phase 81: wikiLLM/Graphify Knowledge Projection - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions captured in CONTEXT.md — this log preserves the analysis.

**Date:** 2026-05-04
**Phase:** 81-wikillm-graphify-knowledge-projection
**Mode:** auto (--auto --chain)
**Areas analyzed:** wikiLLM Living Memory Integration (WIKI-01), Graphify v3 Corpus Graph Sidecar Integration (WIKI-02), RT2-Native Operation & Paperclip Residue (WIKI-03)

## Auto-Mode Decisions

Phase 81 ran with `--auto --chain` flags. In `--auto` mode, all gray areas were auto-selected and recommended defaults were applied without user prompting. The following decisions were made autonomously based on prior phase context and codebase analysis:

### WIKI-01 (wikiLLM Living Memory Integration)
- **D-01:** wikiLLM materialization path verified as `rt2KnowledgeProjectorService.projectWikiForCompany` — the canonical path confirmed from Phase 68 decisions and codebase analysis.
- **D-02:** Five page types (`index`, `log`, `topic`, `project`, `schema`) confirmed as the canonical vocabulary per `Rt2WikiPageType` contract.
- **D-03:** Provenance contract (`Rt2WikiPageProvenance`) confirmed as canonical for source event tracking.
- **D-04:** Update evidence contract (`Rt2WikiPageUpdateEvidence`) confirmed as canonical for materialization evidence.
- **D-05:** Unified confidence vocabulary (`EXTRACTED`, `INFERRED`, `AMBIGUOUS`) confirmed as shared between wiki and corpus graph.

### WIKI-02 (Graphify v3 Corpus Graph Sidecar)
- **D-06:** Corpus graph separation from product graph confirmed via `rt2CorpusGraphService` implementation.
- **D-07:** SHA256 incremental cache confirmed as corpus graph ingest strategy.
- **D-08:** Deterministic extraction interface confirmed as the extraction approach.
- **D-09:** `connected_components_fallback` clustering algorithm confirmed as explicit fallback naming.
- **D-10:** All seven query APIs confirmed as existing (`getNode`, `getNeighbors`, `getCommunity`, `getGodNodes`, `getShortestPath`, `getStats`, `getReport`).
- **D-11:** Corpus/product graph boundary statement confirmed in report markdown.
- **D-12:** wikiLLM → corpus graph integration bridge identified as an open verification question for Phase 81.
- **D-13:** Phase 69 separation decision confirmed as binding constraint.

### WIKI-03 (RT2-Native Operation)
- **D-14:** `rt2-*` namespacing confirmed as the RT2-native pattern for knowledge/graph services.
- **D-15:** `@paperclipai/*` package usage confirmed as compatibility-layer only.
- **D-16:** `rt2KnowledgeProjectorService` confirmed as canonical wiki projector.

## Gray Areas Identified

### WIKI-01 Gray Areas
1. **wikiLLM ↔ Corpus Graph Integration Bridge** — Whether wiki page materialization feeds into corpus graph source ingestion is not confirmed in Phase 68/69 artifacts. Phase 81 should verify this bridge exists or is out of scope.
2. **Provenance Chain Completeness** — Whether every wiki page mutation emits `sourceEventIds` and structured provenance is fully verified.
3. **Page Type Expansion Coverage** — Whether all five `Rt2WikiPageType` values are actually produced by `projectWikiForCompany`.

### WIKI-02 Gray Areas
1. **Corpus Graph Source Schema** — Need to verify the corpus graph DB schema exists (`rt2_v33_corpus_graph_*` tables) and is complete.
2. **Clustering Algorithm Correctness** — Verify `connectedComponents` produces meaningful community assignments.
3. **God Nodes Computation** — Verify 10% centrality threshold and `isGodNode` assignment works correctly.

### WIKI-03 Gray Areas
1. **Legacy Pattern Scan** — Need to scan knowledge/graph code for any remaining Paperclip legacy patterns (`WorkQueue`, `AgentTask`, etc.).
2. **@paperclipai/* Import Scope** — Need to verify all `@paperclipai/*` imports in knowledge/graph code are for schema compatibility only.

## Assumptions Applied (from Prior Phase Context)

From Phase 68 decisions:
- `Rt2WikiPageType` = `"index" | "log" | "topic" | "project" | "schema"` is the canonical vocabulary
- `Rt2WikiPageProvenance` tracks source event IDs, event types, and entity refs
- `Rt2WikiPageUpdateEvidence` shape captures touched pages, source event count, and related page keys
- Jarvis citation/draft loop uses `rt2JarvisService.getTaskAdvice` extended for wiki targets

From Phase 69 decisions:
- `rt2CorpusGraphService` in `server/src/services/rt2-corpus-graph.ts` is the canonical corpus graph service
- Corpus graph is separate from `rt2_v33_graph_*` product graph tables
- Source types: `repo_file`, `doc_file`, `wiki_page`, `external_reference`
- Node types: `source_file`, `heading`, `symbol`, `term`
- Clustering: `connected_components_fallback` (explicitly not Leiden)
- Query APIs: node, neighbors, community, god nodes, shortest path, stats, report

## Open Questions for Phase 81 Planning

1. Is the wikiLLM → corpus graph integration bridge (D-12) actually wired, or is it future scope?
2. Does `projectWikiForCompany` actually emit all five page types, or is it partial?
3. Are there any Paperclip legacy patterns remaining in knowledge/graph services that Phase 81 should flag for Phase 82/83 cleanup?

---

*Phase: 81-wikillm-graphify-knowledge-projection*
*Discussion log auto-generated: 2026-05-04*
*Mode: auto (--auto --chain)*
