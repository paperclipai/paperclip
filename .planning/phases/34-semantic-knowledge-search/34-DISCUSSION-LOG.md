# Phase 34: Semantic Knowledge Search - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-28
**Phase:** 34-semantic-knowledge-search
**Mode:** `--auto --chain`
**Areas discussed:** Search API shape, Ranking and fallback, Result contract, Filters and operator surface, Compatibility and migration

---

## Search API Shape

| Option | Description | Selected |
|--------|-------------|----------|
| Adapt `/rt2/search` | Keep the existing operator API path and upgrade it to consume semantic chunks plus lexical fallback. | ✓ |
| Add a separate semantic endpoint | Create a new endpoint and leave legacy search untouched. | |
| UI-only composition | Let the UI call semantic-index status and legacy search separately. | |

**Auto choice:** Adapt `/rt2/search`.
**Notes:** This preserves legacy route continuity while making the search contract honest and Phase 34-compliant.

---

## Ranking and Fallback

| Option | Description | Selected |
|--------|-------------|----------|
| Semantic-first with lexical fallback | Use Phase 33 vectors when available, then blend lexical/source/freshness signals. | ✓ |
| Lexical-first with semantic badges | Keep current lexical ranking and only annotate semantic metadata. | |
| Provider-only semantic ranking | Require live embeddings/vector database for meaningful ranking. | |

**Auto choice:** Semantic-first with lexical fallback.
**Notes:** Provider-only behavior violates v2.5 deterministic local development requirements.

---

## Result Contract

| Option | Description | Selected |
|--------|-------------|----------|
| Evidence-forward result contract | Include source type/key, snippet/chunk, score evidence, freshness, confidence, and provenance. | ✓ |
| Minimal search result contract | Keep only title, snippet, score, and updatedAt. | |
| Phase-specific contracts per source | Return unrelated shapes for wiki, graph, and artifact results. | |

**Auto choice:** Evidence-forward result contract.
**Notes:** Jarvis grounding and contradiction review will later consume these fields, so Phase 34 should avoid reshaping later.

---

## Filters and Operator Surface

| Option | Description | Selected |
|--------|-------------|----------|
| KnowledgePage search tab | Add a dense search view inside the existing Knowledge route with filters and status hints. | ✓ |
| New standalone page | Build a separate semantic search route. | |
| API-only phase | Skip UI and expose only backend search. | |

**Auto choice:** KnowledgePage search tab.
**Notes:** SEARCH-01 through SEARCH-03 require an operator-facing surface, not API-only behavior.

---

## Compatibility and Migration

| Option | Description | Selected |
|--------|-------------|----------|
| Update legacy tests to the new contract | Preserve coverage while changing expectations to true semantic + lexical behavior. | ✓ |
| Delete old hybrid search tests | Remove stale tests and rely only on new tests. | |
| Keep old implementation beside new one | Maintain two search systems during v2.5. | |

**Auto choice:** Update legacy tests to the new contract.
**Notes:** Phase 6 hybrid search is prior evidence. The right move is to evolve it, not hide the regression risk.

---

## the agent's Discretion

- Exact ranking weights.
- Default result limit and debounce interval.
- Whether the upgraded service keeps the `rt2HybridSearchService` name or moves to a semantic knowledge search service.
- Exact visual layout inside the Knowledge search tab, within existing RT2 UI patterns.

## Deferred Ideas

- Phase 35 contradiction candidate generation and resolution workflow.
- Phase 36 Jarvis grounded answer composition.
- Phase 37 knowledge intelligence operations dashboard.
- Cross-company semantic federation and autonomous knowledge rewrites.
