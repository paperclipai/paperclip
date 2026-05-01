# Phase 69: Graphify v3 Corpus Graph Sidecar - Research

**Date:** 2026-05-01
**Status:** Complete

## Summary

Phase 69 should implement a separate, company-scoped corpus graph sidecar instead of extending the existing project-scoped product graph. The minimum complete implementation is a typed ingest/cache/extraction/query/report stack with focused tests and DevPlan alignment evidence.

## Technical Findings

### Persistence

Use new corpus graph tables:

- `rt2_v33_corpus_graph_sources` for source files and SHA256 cache.
- `rt2_v33_corpus_graph_nodes` for source files, headings, symbols, and terms.
- `rt2_v33_corpus_graph_edges` for provenance-backed relationships.
- `rt2_v33_corpus_graph_communities` for explicit fallback clustering output.
- `rt2_v33_corpus_graph_reports` for generated report evidence.

This avoids overloading `rt2_v33_graph_nodes`, which requires `projectId` and already represents RT2 product graph evidence.

### Extraction

The first implementation should be deterministic and dependency-light:

- Markdown headings and wiki links.
- Code imports, exports, functions, classes, interfaces, types, and const declarations.
- High-signal terms extracted from headings/symbols/content.
- Cross-source `shared_concept` edges only when terms repeat across distinct sources.

Tree-sitter/provider extraction can be added later behind this interface. Phase 69 can still satisfy the roadmap by explicitly naming the current algorithm as deterministic fallback rather than claiming full upstream parity.

### Clustering And Queries

Connected components plus degree-centrality label assignment is sufficient as an explicit fallback. It should be named `connected_components_fallback` or similar. Query APIs should support:

- Node lookup by key.
- Neighbors for a node.
- Community lookup.
- Shortest path.
- God nodes.
- Graph stats.

### Report

The report should include:

- Corpus graph counts and confidence distribution.
- Product graph counts from existing `rt2_v33_graph_*` tables.
- Explicit product/corpus boundary statement.
- Knowledge gaps from thin sources, isolated nodes, ambiguous edges.
- Surprising connections from low-confidence or cross-source inferred edges.
- Suggested questions from god nodes and gaps.

## Risks

- **Overclaiming Leiden/tree-sitter parity:** Avoid by naming fallback algorithms plainly.
- **Product graph conflation:** Avoid through separate tables, route names, and report wording.
- **No provenance:** Block completion if edges do not expose source path/line/rationale metadata.
- **Schema drift:** Add migration and update Drizzle schema together.

## Verification Strategy

- Shared type/validator tests for corpus graph ingest/query schemas.
- Service test for ingest, cache skip, extraction provenance, clustering, shortest path, report boundary.
- Route test for ingest and all query endpoints.
- Alignment gate test for Graphify row completion.
- `pnpm typecheck && pnpm test`.
