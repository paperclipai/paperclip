# Phase 33: Semantic Index Foundation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-28
**Phase:** 33-Semantic Index Foundation
**Areas discussed:** Index Storage Boundary, Source Ingestion Scope, Embedding Provider and Fallback, Incremental Reindex Operation

---

## Index Storage Boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Separate semantic index layer | Add new company-scoped semantic index rows/chunks that reference existing wiki/graph/work sources without replacing them. | ✓ |
| Mutate source tables directly | Add embedding fields onto each source table. Faster initially, but couples derived index state to business truth. | |
| Reuse legacy search metadata only | Extend `rt2_search_index` as the whole semantic index. Too coarse for chunk/provenance/freshness requirements. | |

**User's choice:** `[auto]` Separate semantic index layer.
**Notes:** Chosen because SEM-01 explicitly says not to replace existing wiki/graph/projector storage, and the existing `rt2_search_index` table is metadata-level.

---

## Source Ingestion Scope

| Option | Description | Selected |
|--------|-------------|----------|
| Daily wiki, graph nodes/edges, work artifacts | Cover exactly SEM-02 source classes and keep later search/Jarvis/contradiction behavior out of scope. | ✓ |
| Include all RT2 documents and comments | Broader corpus, but expands Phase 33 beyond the roadmap. | |
| Start with wiki only | Simpler implementation, but fails SEM-02 graph/work artifact coverage. | |

**User's choice:** `[auto]` Daily wiki, graph nodes/edges, work artifacts.
**Notes:** Keeps the phase aligned to SEM-01 through SEM-04.

---

## Embedding Provider and Fallback

| Option | Description | Selected |
|--------|-------------|----------|
| Injectable provider plus deterministic fallback | Provider-backed embeddings when configured; stable local fallback when not. | ✓ |
| Provider required | Simpler production path but violates local dev/CI deterministic fallback requirement. | |
| Fallback only | Good for tests but does not prepare the system for real semantic retrieval. | |

**User's choice:** `[auto]` Injectable provider plus deterministic fallback.
**Notes:** Locks provider optionality and deterministic tests as first-class behavior.

---

## Incremental Reindex Operation

| Option | Description | Selected |
|--------|-------------|----------|
| Full and changed-source reindex with run status | Support full rebuild plus incremental refresh, exposing run counts, status, timestamps, and errors. | ✓ |
| Full rebuild only | Easier but fails SEM-04 changed-source refresh expectation. | |
| Background-only hidden reindex | Avoids API design now, but operators cannot inspect run state. | |

**User's choice:** `[auto]` Full and changed-source reindex with run status.
**Notes:** Operator inspection can start as API/status tests; the richer health dashboard is deferred to Phase 37.

---

## the agent's Discretion

- Exact table names, chunk size, hash algorithm, and fallback vector format.
- Whether to create a dedicated semantic-index route or place endpoints near existing RT2 search routes.
- Whether to reuse `rt2SearchIndex` for summary status only, provided semantic index rows remain separate.

## Deferred Ideas

- Semantic search UI and ranking filters — Phase 34.
- Contradiction review candidates — Phase 35.
- Jarvis grounded answers — Phase 36.
- Knowledge operations dashboard and health gates — Phase 37.
- Cross-company federation and autonomous wiki rewrites — outside v2.5.
