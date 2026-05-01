# Phase 68: wikiLLM Living Memory Workflow - Context

**Gathered:** 2026-05-01
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 68 connects the existing RealTycoon2 event/wiki store to a wikiLLM-compatible living memory workflow: `index.md`, `log.md`, topic/project/schema pages, provenance/confidence/contradiction-aware update evidence, and Jarvis grounded answers that can cite wiki memory and create reviewable wiki draft/update proposals.

This phase must build on the existing RT2 knowledge projector, daily wiki, semantic index, contradiction review, and Jarvis rewrite proposal systems. It must not implement the Phase 69 Graphify v3 corpus graph sidecar, Phase 70 economy/P&L/CareerMate loop, or Phase 71 final acceptance gate. It may update the DevPlan alignment gate only for the wikiLLM memory row it proves with code, UI/API evidence, and focused tests.

</domain>

<decisions>
## Implementation Decisions

### wikiLLM File Model
- **D-01:** Keep the database/event projector as the primary write path. Markdown files are materialized/export output, not the canonical source of truth.
- **D-02:** Preserve `index.md` and `log.md` as top-level wikiLLM files, generated from company-scoped RT2 domain events.
- **D-03:** Expand the current topic-only page model to cover explicit topic, project, and schema pages. Recommended file layout is `topics/<entityType>/<entityId>.md`, `projects/<projectId>.md`, and `schemas/<entityType>.md`.
- **D-04:** The shared `Rt2WikiPageType`/validator contract should become explicit enough for downstream UI/API code to distinguish `index`, `log`, `topic`, `project`, and `schema` pages rather than overloading all non-index pages as `topic`.
- **D-05:** A wikiLLM export bundle should list stable file paths, page keys, page type, markdown content, source event IDs, updated timestamp, provenance summary, confidence summary, and contradiction status. Existing Obsidian-compatible export can be reused, but Phase 68 completion needs wikiLLM semantics, not only Obsidian naming.

### Living Memory Update Evidence
- **D-06:** Every ingest/update projection must preserve provenance through `sourceEventIds` plus structured page metadata. Metadata should include source entity IDs, source event types, related page keys, confidence summary, contradiction flag/status, and last materialized reason.
- **D-07:** Updating a source event should update the related pages as a set: `index.md`, `log.md`, entity topic page, actor topic page, project page when project-scoped, and schema page for the entity type.
- **D-08:** Projection should return or persist update evidence that downstream UI/tests can inspect: pages created/updated, related pages touched, source event IDs consumed, confidence distribution, contradiction candidates linked, and skipped/no-op reason where applicable.
- **D-09:** Confidence vocabulary should reuse existing RT2 graph/semantic terms (`EXTRACTED`, `INFERRED`, `AMBIGUOUS`) and should not invent a second incompatible confidence scheme for wiki pages.
- **D-10:** Contradiction handling should reuse `rt2V33ContradictionCandidates` and `rt2WikiLintService` where possible. A page with open contradiction evidence remains usable as a citation, but Jarvis/UI must show it as review-needed rather than silently treating it as settled knowledge.

### Jarvis Citation And Draft Loop
- **D-11:** Jarvis grounded answers should expose wiki citations as first-class evidence: citation ID, page key, page type, snippet, freshness, confidence, contradiction status, and a UI target path.
- **D-12:** Extend existing `rt2JarvisService.getTaskAdvice` and hybrid-search citation mapping instead of creating a separate Jarvis memory subsystem. The same citation contract should serve task advice, project insights, and update proposals where feasible.
- **D-13:** Wiki update suggestions must go through the existing Jarvis rewrite proposal and approval path. No autonomous direct wiki rewrite is allowed in this phase.
- **D-14:** Reviewable wiki drafts should target `wiki_page` or `daily_wiki_page`, carry before/after markdown diff, citations, contradiction IDs, fallback/provider eval, risk level, approval route, and activity-log evidence.
- **D-15:** Approval or rejection should leave audit evidence and should not mutate wiki content without an explicit approved apply path. If the current rewrite proposal path only records decisions, planning should add a narrow approved-apply path for wiki targets with tests.

### Operator Surface
- **D-16:** Extend the existing `KnowledgePage`, `Rt2DailyWikiPanel`, and relevant Jarvis/quality panels rather than creating a new standalone wikiLLM-branded product page.
- **D-17:** Product-facing copy remains Korean-first and RealTycoon2/Jarvis oriented. `wikiLLM` may appear in planning/docs or an engine-reference note, but operator copy should describe living memory, wiki evidence, citations, and reviewable updates.
- **D-18:** The Knowledge surface should make the living memory loop inspectable: export/materialize status, page type filters, related page update evidence, citation links, contradiction flags, and pending Jarvis wiki drafts.
- **D-19:** The Daily cockpit and task/Jarvis surfaces should consume the same citation/update evidence so memory feels attached to work, not hidden behind a maintenance page.

### DevPlan Alignment And Verification
- **D-20:** Update `scripts/rt2-devplan-alignment-gate.mjs` so `wikiLLM living memory workflow` becomes `complete` only after file model export/materialization, provenance/confidence/contradiction update evidence, Jarvis citations, and reviewable wiki draft/update loop are all anchored.
- **D-21:** Focused verification should include shared wiki/Jarvis contract tests, knowledge projector service tests, knowledge/Jarvis route tests, Knowledge/Daily/Jarvis UI tests where touched, and the DevPlan alignment gate test.
- **D-22:** Default verification remains `pnpm typecheck && pnpm test`. Do not run `pnpm test:e2e` as the default Phase 68 gate.

### the agent's Discretion
- Exact field names for page update evidence, provided they are typed in shared contracts and visible through route/service tests.
- Whether wikiLLM export is a new route or a stricter mode of the existing vault export, provided downstream code can request wikiLLM-specific metadata and file layout.
- Exact UI placement for pending wiki drafts and citation warnings, provided the Knowledge page and Jarvis/task surfaces expose them without a separate product silo.
- Exact migration shape for page type expansion, provided existing `index`, `log`, and `topic` pages remain readable.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Milestone Truth
- `AGENTS.md` - Korean-first workflow, RealTycoon2 terminology, verification command policy, lockfile policy, and no-overplanning guidance.
- `.planning/PROJECT.md` - v3.1 DevPlan Core Convergence goal, RealTycoon2-first identity, wikiLLM/Graphify boundary, and brownfield constraints.
- `.planning/REQUIREMENTS.md` - `WIKI-01`, `WIKI-02`, and `WIKI-03`.
- `.planning/ROADMAP.md` - Phase 68 goal, success criteria, and v3.1 dependency chain.
- `.planning/STATE.md` - Phase 68 current position and v3.1 cumulative context.
- `.planning/phases/65-devplan-truth-and-identity-cleanup/65-CONTEXT.md` - Evidence-backed completion rule and engine parity boundary.
- `.planning/phases/66-daily-work-and-okr-cockpit-convergence/66-CONTEXT.md` - Daily cockpit/Jarvis/evidence surface decisions.
- `.planning/phases/67-multica-runtime-execution-alignment/67-CONTEXT.md` - Runtime/event evidence feeding the memory loop.
- `.planning/devplan-alignment-runs/2026-05-01T03-21-32-046Z/report.md` - Latest alignment baseline before wikiLLM Phase 68.

### Existing wiki/Jarvis Decisions
- `.planning/phases/05-wikillm-and-graphify-knowledge-core/05-CONTEXT.md` - Original cumulative wiki and Graphify knowledge core decisions.
- `.planning/phases/21-obsidian-bidirectional-knowledge-sync/21-CONTEXT.md` - Existing vault export/import and conflict review boundary.
- `.planning/phases/25-daily-wiki-projector/25-CONTEXT.md` - Daily wiki projector baseline.
- `.planning/phases/34-semantic-knowledge-search/34-CONTEXT.md` - Semantic/lexical search and citation evidence baseline.
- `.planning/phases/35-contradiction-review-workflow/35-CONTEXT.md` - Contradiction candidate and review workflow decisions.
- `.planning/phases/36-jarvis-grounded-answers/36-CONTEXT.md` - Jarvis citation and grounded answer baseline.
- `.planning/phases/42-jarvis-autonomy-eval-guardrails/42-CONTEXT.md` - Approval-first Jarvis rewrite/autonomy guardrail.

### Existing Code And Tests
- `packages/db/src/schema/rt2_v33_wiki_pages.ts` - Current cumulative wiki page persistence.
- `packages/db/src/schema/rt2_v33_daily_wiki_pages.ts` - Current daily wiki persistence.
- `packages/db/src/schema/rt2_v33_semantic_index.ts` - Semantic chunks, provenance, freshness, provider fallback metadata.
- `packages/db/src/schema/rt2_v33_contradiction_review.ts` - Contradiction candidate/resolution persistence.
- `packages/db/src/schema/rt2_jarvis_autonomy.ts` - Jarvis rewrite proposals, evals, citations, approval linkage.
- `packages/shared/src/types/rt2-knowledge.ts` - Current wiki, vault, bridge, contradiction, and operations contracts.
- `packages/shared/src/validators/rt2-knowledge.ts` - Current wiki page query and vault import validators.
- `packages/shared/src/types/rt2-governance.ts` - Jarvis rewrite proposal, citation, grounded advice, and eval contracts.
- `packages/shared/src/types/rt2-daily-report.ts` - Daily wiki page and answer contracts.
- `packages/shared/src/rt2-knowledge.test.ts` - Current shared wiki validator coverage.
- `server/src/services/rt2-knowledge-projector.ts` - Main wiki/graph projector, `index.md`/`log.md`/topic materialization, vault export/import, bridge queue, and daily wiki graph projection.
- `server/src/services/rt2-daily-report.ts` - Daily wiki materialization and answer baseline.
- `server/src/services/rt2-semantic-index.ts` - Semantic indexing source collection and provenance/freshness behavior.
- `server/src/services/rt2-contradiction-review.ts` - Contradiction candidate generation and resolution.
- `server/src/services/rt2-jarvis.ts` - Jarvis grounded citations, task advice, rewrite proposal/eval/approval path.
- `server/src/routes/rt2-knowledge.ts` - Existing wiki/vault/bridge/daily knowledge routes to extend.
- `server/src/routes/rt2-jarvis.ts` - Existing Jarvis advice and rewrite proposal routes to extend.
- `server/src/__tests__/rt2-knowledge-projector.test.ts` - Projector service coverage.
- `server/src/__tests__/rt2-knowledge-routes.test.ts` - Knowledge route coverage.
- `server/src/__tests__/rt2-semantic-index.test.ts` - Semantic index route/service evidence.
- `server/src/__tests__/rt2-wiki-lint.test.ts` - Wiki lint and contradiction input evidence.
- `ui/src/pages/rt2/KnowledgePage.tsx` - Main knowledge/search/wiki/graph/bridge/operations surface.
- `ui/src/components/Rt2DailyWikiPanel.tsx` - Daily wiki rendering surface.
- `ui/src/components/Rt2QualityPanel.tsx` - Jarvis rewrite proposal review surface.
- `ui/src/api/rt2-knowledge.ts` - Knowledge client API.
- `ui/src/api/rt2-jarvis-runtime.ts` - Jarvis rewrite proposal client API.
- `scripts/rt2-devplan-alignment-gate.mjs` - v3.1 alignment score and wikiLLM row completion truth.
- `scripts/rt2-devplan-alignment-gate.test.mjs` - Focused alignment gate tests.

### Reference Boundary
- `.planning/research/ENGINE-REFERENCE-AUDIT.md` - Confirms wikiLLM/Graphify/Multica engine boundaries and warns against overclaiming engine parity.
- `_refs/graphify-v3/graphify/wiki.py` - Upstream-style generated wiki/export behavior reference only; do not conflate with Phase 69 Graphify corpus graph sidecar.
- `_refs/graphify-v3/README.md` - General Graphify v3 reference for wiki/corpus memory language; Phase 68 may borrow file-memory ideas but not claim full Graphify parity.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `rt2V33WikiPages` already persists company-scoped `pageKey`, `pageType`, markdown, summary, source event IDs, and metadata.
- `rt2KnowledgeProjectorService.projectWikiForCompany` already materializes `index.md`, `log.md`, and topic pages from RT2 domain events.
- `rt2KnowledgeProjectorService.exportObsidianVault`, `dryRunVaultWriter`, import preview/apply, and conflict resolution already provide markdown export/import mechanics and source-event frontmatter.
- `rt2V33DailyWikiPages` and `rt2DailyReportService.materializeDailyWikiPage` already create per-day markdown pages from activity-log evidence.
- `rt2V33SemanticIndexChunks` already stores provenance, freshness, embedding provider/model, and source metadata for wiki/daily/wiki/graph/work artifact search.
- `rt2V33ContradictionCandidates` already stores open/resolved contradiction evidence with confidence and source pair metadata.
- `rt2JarvisService.getTaskAdvice` already returns grounded citations and warnings from hybrid search plus contradiction candidates.
- `rt2JarvisRewriteProposals` and `rt2JarvisRewriteEvals` already implement reviewable before/after proposals, citations, fallback/provider evals, risk, approval route, and audit log events.
- `KnowledgePage` already has search, wiki, bridge, operations, contradiction, graph, export/import, local bridge, and citation-link surfaces.

### Established Patterns
- Product-facing UI is Korean-first and RealTycoon2/Jarvis/work oriented; engine names belong in docs/reference boundaries.
- Event-first projection is the preferred architecture for high-contention business memory.
- Markdown is an inspection/export artifact; RT2 DB/projector remains canonical.
- Approval-first Jarvis changes are locked by prior phases; autonomous wiki rewrites remain out of scope.
- Focused service/route/component/script tests are the accepted proof for this Windows host. Playwright e2e is not default.
- DevPlan alignment rows must not become `complete` unless evidence anchors exist and engine parity is not overstated.

### Integration Points
- Expand shared wiki page types and validators before changing server routes or UI filters.
- Extend `rt2KnowledgeProjectorService` to materialize project/schema pages and structured related-page update evidence.
- Extend wiki export output to include wikiLLM metadata while preserving existing vault export compatibility.
- Add or extend routes in `server/src/routes/rt2-knowledge.ts` for wikiLLM export/materialization/update evidence.
- Extend `rt2JarvisService` citation and rewrite proposal paths for wiki page update drafts and approved apply behavior.
- Surface living memory status, related page updates, citation warnings, contradiction flags, and pending wiki drafts in `KnowledgePage`, `Rt2DailyWikiPanel`, `Rt2QualityPanel`, and any touched Jarvis/task surfaces.
- Update `scripts/rt2-devplan-alignment-gate.mjs` only after implementation and tests prove the WIKI requirements.

</code_context>

<specifics>
## Specific Ideas

- Recommended page type set: `index`, `log`, `topic`, `project`, `schema`.
- Recommended wikiLLM export file shape: `{ path, pageKey, pageType, title, content, sourceEventIds, updatedAt, provenance, confidence, contradictionStatus, relatedPageKeys }`.
- Recommended update evidence shape: `{ eventId, sourceEventType, sourceEntity, pagesTouched, confidenceSummary, contradictionStatus, relatedPageKeys, projectedAt }`.
- Recommended Jarvis wiki draft shape: existing `Rt2JarvisRewriteProposalInput` with `targetType: "wiki_page" | "daily_wiki_page"`, markdown `before`/`after`, citations from wiki/daily/wiki/graph/search, and contradiction IDs.
- A useful schema page can summarize field/event contracts from source event payload metadata first; Phase 69 can later enrich corpus/code extraction without taking over Phase 68.

</specifics>

<deferred>
## Deferred Ideas

- Phase 69 owns Graphify v3 corpus graph sidecar, file cache, provenance, clustering, shortest path/query/report, and MCP-style graph memory.
- Phase 70 owns Marketplace, P&L, amoeba economy, and CareerMate progression.
- Phase 71 owns the final v3.1 score delta and acceptance gate.
- Full bidirectional local vault writer daemon and filesystem watcher remain future hardening; Phase 68 can keep server-side local write as dry-run/contract evidence.
- Autonomous Jarvis direct wiki apply without approval remains out of scope.

</deferred>

---

*Phase: 68-wikillm-living-memory-workflow*
*Context gathered: 2026-05-01*
