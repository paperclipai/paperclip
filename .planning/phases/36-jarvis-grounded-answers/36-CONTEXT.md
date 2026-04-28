# Phase 36 Context - Jarvis Grounded Answers

## Goal

Jarvis answers must use RT2 semantic knowledge with operator-verifiable citations and warnings when cited evidence is stale or contradicted.

## Relevant Current State

- `server/src/services/rt2-jarvis.ts` already returns task advice from live task, To-Do, deliverable, wiki, and graph rows.
- Phase 34 added `rt2HybridSearchService` over semantic chunks and lexical fallback.
- Phase 35 added contradiction candidates/resolutions and marks affected semantic chunks stale while candidates are open.
- Existing route boundary is `/companies/:companyId/rt2/jarvis/tasks/:taskIssueId/advice` with `assertCompanyAccess`.

## Decisions

- Extend the existing task advice response instead of creating a second answer endpoint.
- Use semantic retrieval as an internal grounding layer, scoped by `companyId` and task `projectId`.
- Surface citations as typed source references with enough routing data for UI links.
- Surface warnings for stale semantic evidence and open contradiction candidates.
- Keep generated suggestions deterministic; this phase does not add provider LLM generation.

## Risks

- The repo has a large existing dirty RT2 baseline, so code commits may capture unrelated files.
- Embedded Postgres tests may be skipped on unsupported Windows hosts; package typecheck and full unit suite remain required.

