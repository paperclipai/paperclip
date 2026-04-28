# Phase 34: Semantic Knowledge Search - Research

**Date:** 2026-04-28
**Status:** Complete

## Findings

Phase 34 can be implemented by upgrading the existing RT2 search route instead of introducing a separate search surface. The existing `/companies/:companyId/rt2/search` route already has the right company-scoped shape and legacy tests, but the service previously treated source-type weighting as `semantic-rerank`. Phase 33 delivered real semantic chunks, deterministic fallback embeddings, reindex status, and company-scoped source provenance, so Phase 34 should consume that foundation directly.

## Existing Assets

- `packages/db/src/schema/rt2_v33_semantic_index.ts` provides indexed chunks with source type, source ID/key, project ID, chunk text, JSON embedding, freshness, source date, and provenance.
- `server/src/services/rt2-semantic-index.ts` provides deterministic query/source embeddings and reindex source collection.
- `server/src/services/rt2-hybrid-search.ts` provides legacy lexical fallback for documents, wiki pages, tasks, deliverables, graph nodes, and graph edges.
- `server/src/routes/rt2-hybrid-search.ts` already exposes the operator API path and uses `assertCompanyAccess`.
- `ui/src/pages/rt2/KnowledgePage.tsx` is the correct operator surface because daily/wiki/graph/bridge knowledge already lives there.

## Implementation Guidance

- Prefer semantic chunks first when available, then keep lexical fallback for empty or stale index states.
- Compute deterministic vector similarity in application code for local dev and CI. Do not require pgvector.
- Add filter params to the existing search route: project/work object, source type, date range, confidence, and contradiction status.
- Make evidence labels honest: `semantic-index` for vector similarity and `lexical-fallback` for source-table matching.
- Add a `KnowledgePage` search tab with dense result cards, filters, and index status/reindex controls.

## Risks

- Embedded Postgres semantic route coverage is skipped by default on Windows, so typecheck and pure fallback tests are necessary but not sufficient for DB behavior.
- Existing untracked Phase 33 code is part of the working tree baseline; avoid broad commits that capture unrelated prior work.

## Validation Targets

- `pnpm typecheck`
- `pnpm test -- rt2-semantic-index rt2-phase6-intelligence`
- `pnpm test`

