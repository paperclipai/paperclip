# Phase 69: Graphify v3 Corpus Graph Sidecar - Discussion Log

> Audit trail only. Do not use as input to planning, research, or execution agents.
> Decisions captured in CONTEXT.md.

**Date:** 2026-05-01
**Mode:** auto
**Areas analyzed:** Corpus graph boundary, source ingest/cache, extraction provenance, query/clustering API, graph report, DevPlan verification

## Auto-Selected Gray Areas

### Corpus Graph Boundary
- [auto] Selected separate corpus graph sidecar tables instead of widening the existing RT2 product graph tables.
- [auto] Preserved RealTycoon2 product identity and treated Graphify as engine/reference language.

### Source Ingest And Cache
- [auto] Selected SHA256 source cache with explicit source location metadata.
- [auto] Selected typed service/route ingest for repo/docs/wiki files as the first implementation boundary.

### Extraction Provenance
- [auto] Selected deterministic code/docs extraction interface for Phase 69, with future tree-sitter/provider extraction behind the same contract.
- [auto] Required confidence score, confidence label, rationale, and provenance evidence for every edge.

### Query And Clustering API
- [auto] Selected company-scoped corpus graph APIs for node, neighbors, community, shortest path, god nodes, and stats.
- [auto] Selected explicit fallback clustering naming instead of claiming Leiden without a real Leiden dependency.

### Corpus Report
- [auto] Selected a report that compares corpus graph and product graph counts while keeping the two graph types distinct.
- [auto] Required knowledge gaps, surprising connections, and suggested questions derived from graph structure.

### Verification
- [auto] Selected focused shared/service/route/script tests plus `pnpm typecheck && pnpm test`.
- [auto] Did not select Playwright e2e as a default gate.

## Prior Decisions Applied

- Phase 65: completion claims need code/schema/route/test evidence and engine parity must cite `ENGINE-REFERENCE-AUDIT.md`.
- Phase 68: wikiLLM file memory is complete but does not count as Graphify v3 corpus graph parity.
- Phase 26/05: existing graph confidence and report concepts are useful but project/product graph projection must not be confused with corpus graph extraction.

## Deferred Ideas

- Real tree-sitter extraction, provider-assisted semantic extraction, Neo4j/HTML exports, and MCP server exposure.
- Corpus graph UI visualization.
- Phase 70 economy and Phase 71 final acceptance gate.
