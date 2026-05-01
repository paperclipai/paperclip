# Phase 68: wikiLLM Living Memory Workflow - Research

**Date:** 2026-05-01
**Mode:** inline research because Codex subagent spawning was not explicitly requested.
**Status:** Ready for planning

## Research Complete

Phase 68 should be implemented as a brownfield convergence of the existing RT2 knowledge stack. The repo already has most of the substrate:

- `rt2V33WikiPages` persists company-scoped cumulative wiki pages with `pageKey`, `pageType`, markdown, summary, `sourceEventIds`, and metadata.
- `rt2KnowledgeProjectorService.projectWikiForCompany` already materializes `index.md`, `log.md`, and topic pages from RT2 domain events.
- `rt2V33DailyWikiPages` and `rt2DailyReportService.materializeDailyWikiPage` already create daily markdown pages from activity log evidence.
- `rt2V33SemanticIndexChunks` stores provenance, freshness, content hashes, and provider/fallback embedding metadata.
- `rt2V33ContradictionCandidates` stores open/resolved contradiction evidence with source pairs and confidence.
- `rt2JarvisService.getTaskAdvice` already returns grounded citations and warnings from hybrid search plus contradiction candidates.
- `rt2JarvisRewriteProposals` already provides reviewable before/after proposals, citations, evals, risk, approval route, and audit activity.
- `KnowledgePage`, `Rt2DailyWikiPanel`, and `Rt2QualityPanel` already expose wiki/search/bridge/operations and Jarvis rewrite surfaces.

The missing part is not a new knowledge engine. It is making the existing store comply with the wikiLLM living memory contract: explicit file model, related page update evidence, confidence/contradiction metadata, wiki citations, and reviewable Jarvis wiki updates.

## Findings

### Existing wiki file model

`server/src/services/rt2-knowledge-projector.ts` currently renders:

- `index.md` from company events and linked projects/entity types.
- `log.md` as chronological event lines.
- topic pages under `topics/<entityType>/<entityId>.md`, actor pages, and project-topic pages under `topics/projects/<projectId>.md`.

`packages/shared/src/types/rt2-knowledge.ts` currently restricts `Rt2WikiPageType` to `index | log | topic`. Phase 68 should make project and schema pages explicit so the exported files match the roadmap success criteria instead of hiding everything under `topic`.

### Existing update/provenance model

The projector already stores `sourceEventIds` and metadata, and graph edges already use `EXTRACTED`, `INFERRED`, and `AMBIGUOUS` confidence. Semantic chunks store freshness/provenance, and contradiction candidates store source/conflicting source keys.

Phase 68 can avoid new persistence tables by adding structured update evidence to service return values and page metadata. The most useful durable evidence fields are:

- `relatedPageKeys`
- `sourceEventTypes`
- `sourceEntities`
- `confidenceSummary`
- `contradictionStatus`
- `contradictionCandidateIds`
- `lastMaterializedReason`
- `lastProjectedAt`

### Existing Jarvis fit

`rt2JarvisService.getTaskAdvice` already maps hybrid search results into `GroundedCitation` objects with source key, snippet, confidence, freshness, contradiction status, score, and target route. The missing part is making wiki citations clearer and feeding wiki update suggestions back into the existing rewrite proposal path.

`Rt2JarvisRewriteProposalInput` already supports `targetType: "wiki_page" | "daily_wiki_page"` and carries before/after markdown plus citations and contradiction IDs. This is the right review mechanism. Phase 68 should add a narrow approved-apply path for wiki targets if current proposals only record approval decisions.

### UI fit

`KnowledgePage` already has tabs for search, daily, wiki, graph, bridge, and operations. It also shows vault export/import, contradiction candidates, graph evidence, and citation links. This page should receive the living-memory status and pending wiki draft evidence.

`Rt2QualityPanel` already lists rewrite proposals and request-approval controls. It should be reused for wiki drafts rather than creating a separate wikiLLM inbox.

`Rt2DailyWikiPanel` is the small daily memory surface and should show page key, source event count, and citation/update warning metadata where available.

## Recommended Technical Approach

1. Extend shared knowledge contracts:
   - `Rt2WikiPageType`: `index | log | topic | project | schema`
   - wikiLLM export file/bundle types
   - page update evidence types
   - page metadata/provenance summary types
   - validator coverage for page type filters and export queries
2. Extend projector behavior:
   - materialize project pages under `projects/<projectId>.md`
   - materialize schema pages under `schemas/<entityType>.md`
   - compute related page update evidence per projection
   - include confidence and contradiction summaries in page metadata
   - expose wikiLLM export output while preserving vault export compatibility
3. Extend routes:
   - add wikiLLM export/materialize/update-evidence route or mode
   - keep existing `/wiki-pages`, `/wiki-page`, and vault routes backward-compatible
4. Extend Jarvis:
   - make wiki citations first-class in grounded advice output
   - create wiki rewrite proposals with citations/contradictions/eval
   - add approved apply behavior for `wiki_page` and `daily_wiki_page` targets if needed
5. Extend UI:
   - Knowledge page: page type filters, living memory status, related update evidence, contradiction/citation warnings, pending wiki drafts
   - Daily wiki panel: source/citation/update evidence
   - Quality/Jarvis panel: wiki draft target and approval/apply state
6. Update DevPlan alignment gate only after focused evidence exists.

## Risks And Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Page type expansion breaks existing topic page consumers | Knowledge UI/API tests fail | Keep `topic` readable and add project/schema as additive text values in shared validators. |
| wikiLLM export duplicates Obsidian vault export | Confusing operator/API contract | Keep Obsidian export compatible but add wikiLLM-specific metadata and naming to a distinct method/route or explicit mode. |
| Update evidence is only transient | WIKI-02 cannot be audited | Persist key evidence in page metadata and expose it in route output/tests. |
| Jarvis draft approval mutates content without audit | Violates approval-first decisions | Use existing proposal/eval/approval/activity log path and add tests for approved apply only. |
| Phase 68 drifts into Graphify v3 sidecar | Scope creep into Phase 69 | Limit graph work to existing citation/confidence/contradiction metadata; defer corpus cache, clustering, path/query, and MCP graph memory. |

## Validation Architecture

### Automated Tests

- Shared contracts:
  - `packages/shared/src/rt2-knowledge.test.ts`
  - validates new page types, export/update evidence shapes, and route query schemas.
- Server knowledge projector/routes:
  - `server/src/__tests__/rt2-knowledge-projector.test.ts`
  - `server/src/__tests__/rt2-knowledge-routes.test.ts`
  - covers `index.md`, `log.md`, topic/project/schema pages, wikiLLM export, related page evidence, confidence summary, and contradiction flags.
- Server Jarvis:
  - extend existing Jarvis route/service coverage or add focused assertions in `server/src/__tests__/rt2-knowledge-routes.test.ts` / a Jarvis test file if present.
  - covers wiki citation targets, wiki rewrite proposal creation, approval request, and approved apply behavior.
- UI:
  - add focused assertions in `ui/src/pages/rt2/KnowledgePage` tests if present, otherwise colocate or extend the nearest component tests for `Rt2DailyWikiPanel` and `Rt2QualityPanel`.
- DevPlan gate:
  - `scripts/rt2-devplan-alignment-gate.test.mjs`
  - `pnpm run rt2:devplan-alignment-gate`

### Verification Commands

- `pnpm exec vitest run packages/shared/src/rt2-knowledge.test.ts`
- `$env:PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS='true'; pnpm exec vitest run server/src/__tests__/rt2-knowledge-projector.test.ts server/src/__tests__/rt2-knowledge-routes.test.ts`
- `pnpm exec vitest run ui/src/components/Rt2DailyWikiPanel.test.tsx ui/src/components/Rt2QualityPanel.test.tsx`
- `node scripts/rt2-devplan-alignment-gate.test.mjs`
- `pnpm run rt2:devplan-alignment-gate`
- `pnpm typecheck`
- `pnpm test`

### Manual Checks

None required. Browser e2e is not default per `AGENTS.md`.

## Open Questions

No user input required in `--auto` mode. The planner should choose exact route naming and metadata field names conservatively, preserving existing Knowledge page and vault export compatibility.

---

*Research complete: 2026-05-01*
