# Phase 6: Jarvis, Quality, and Hybrid Search - Summary

**Status:** Complete
**Completed:** 2026-04-25

## What Changed

- Reworked Jarvis task advice, task breakdowns, and project insights to use live RT2 evidence:
  - task profiles,
  - todos,
  - deliverables,
  - wiki pages,
  - graph nodes,
  - quality evaluations.
- Replaced global Jarvis task routes with company-scoped routes:
  - `GET /companies/:companyId/rt2/jarvis/tasks/:taskIssueId/advice`
  - `GET /companies/:companyId/rt2/jarvis/tasks/:taskIssueId/breakdown`
- Added explicit quality evaluation modes:
  - `shadow`: evidence only, inactive, not finalized,
  - `copilot`: pending manager approval,
  - `auto`: auto-approved inside the base-price band.
- Expanded hybrid search across:
  - documents,
  - cumulative wiki pages,
  - RT2 tasks,
  - deliverables,
  - graph nodes,
  - graph edges.
- Added deterministic evidence/rerank metadata to search results.
- Added Phase 6 migration coverage for quality, base-price, and search tables.
- Added focused embedded-Postgres tests for Phase 6 intelligence behavior.

## Verification

- `pnpm exec vitest run server/src/__tests__/rt2-phase6-intelligence.test.ts` - passed.
- `pnpm -r typecheck` - passed.
- `pnpm build` - passed.

## Deferred

- External embedding generation and LLM reranking.
- UI polish beyond replacing backend stub behavior.
