# Phase 41: Native and Mobile Capture Hardening - Context

**Gathered:** 2026-04-29
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 41 hardens the existing RT2 inbound capture path for Slack, Teams, native, and mobile sources. It covers capture source installation state, signed source verification, last inbound event evidence, semantic context and duplicate warnings in the inbound draft review queue, promotion into RT2 work objects, activity log and wiki/semantic indexing continuity, and a mobile-sized knowledge search surface that preserves semantic results, lexical fallback, and citation targets.

This phase does not ship app-store native distribution, push notifications, public marketplace integrations, live Slack/Teams OAuth installation, or automatic promotion without operator review. External capture sources may be represented through deterministic signed-source fixtures and operator-visible installation records.

</domain>

<decisions>
## Implementation Decisions

### Capture Source Trust And Installation
- **D-01:** Extend the existing One-Liner inbound draft source model (`slack`, `teams`, `webhook`, `mobile`, `native`) rather than creating a separate capture subsystem.
- **D-02:** Add company-scoped capture source installation records with source type, display label, installation state, signing status, last inbound event, last error or blocked reason, and audit metadata. Operators should be able to see whether each source is installed, signed, unsigned, stale, blocked, or failing.
- **D-03:** Signed source verification should be deterministic and local-testable. Use shared validators and service-level signature checks over canonical request/event content; live Slack/Teams credential exchange is outside this phase.
- **D-04:** Unsigned or failed-signature inbound events should not be discarded silently. Store or return clear evidence with `permission_blocked`, `source_failure`, or equivalent blocked status, and include reason codes in route/service tests.

### Inbound Draft Review Queue
- **D-05:** Upgrade the existing `/rt2/capture-drafts` queue instead of adding a separate inbox. Queue rows should include source installation/signing evidence, last inbound metadata, semantic context, duplicate warning, permission state, and promotion readiness.
- **D-06:** Duplicate detection should continue to use normalized content, but Phase 41 should make warnings operator-visible across source/channel/user context. Exact duplicates can remain blocked or marked duplicate; near duplicates should be review warnings, not automatic failures.
- **D-07:** Semantic context should be evidence-forward: show top related RT2 knowledge/work results with source type, title, snippet, freshness, confidence, contradiction status, and citation target. Keep deterministic fallback search available when semantic provider data is absent.
- **D-08:** Queue UI should be compact and operational, suitable for repeated review. Prefer dense rows, source badges, status badges, evidence chips, inline promotion controls, and small-viewport-safe stacking over explanatory panels.

### Promotion And Knowledge Continuity
- **D-09:** Promotion remains explicit operator action. A draft may promote to task, todo, or deliverable using the existing `promoteCaptureDraft` targets, but the promoted object must retain capture source evidence and draft ID in metadata/audit trail.
- **D-10:** Promotion must connect to RT2 work object creation, activity log, and the existing wiki/semantic indexing path. If indexing is asynchronous, the promotion result should expose enough source evidence for downstream projector/indexer tests to verify continuity.
- **D-11:** Activity log actions should distinguish inbound capture, signature verification/blocking, duplicate warning, promotion, and failure. Details should include source type, source installation ID if present, signing status, duplicate evidence, promoted IDs, and semantic citation IDs where applicable.
- **D-12:** Do not bypass existing company access checks. All capture source installation, inbound draft, queue, promotion, and search routes remain company-scoped and must use the existing RT2 authz patterns.

### Mobile Knowledge Search Surface
- **D-13:** Extend the existing `KnowledgePage` semantic search surface rather than creating a standalone mobile app. The small viewport view should preserve result title, snippet, source type, score, freshness, confidence, contradiction status, and routeable citation target without horizontal overflow.
- **D-14:** Search must continue to represent semantic plus lexical fallback honestly. Mobile UI can simplify filters, but must not hide fallback mode, stale evidence, or unresolved contradiction warnings.
- **D-15:** Citation targets should be routeable where the existing result has enough source identity: wiki/daily wiki page, graph node/edge, task, deliverable, work artifact, or document. Where routing is unavailable, show the source key as evidence rather than inventing a route.

### Verification
- **D-16:** Add deterministic route/service tests for signed source accepted, unsigned or invalid signature blocked, duplicate warning, stale semantic evidence, capture source installation status, queue evidence shape, and promotion audit details.
- **D-17:** Add UI tests for capture queue evidence rendering and mobile-sized knowledge search layout. The mobile test should assert semantic result, lexical fallback wording, citation target, and no critical text overflow on a narrow viewport.
- **D-18:** Preserve default verification with `pnpm typecheck && pnpm test`. Do not make live Slack/Teams APIs, native OS APIs, push notifications, or provider-backed embeddings mandatory for local/CI success.

### the agent's Discretion
- Exact table names, endpoint names, and source-state enum labels, provided they are company-scoped, typed in shared contracts, migration-backed, and visible in API/UI.
- Exact signature algorithm and canonical payload fields, provided tests cover accepted, missing, invalid, stale, and unsigned paths deterministically.
- Exact mobile search layout, provided it stays dense, readable, non-overlapping, and preserves citation/evidence signals.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product And Phase Scope
- `.planning/PROJECT.md` - RT2-first identity, v2.6 hardening goal, auditability constraints, and deterministic local development constraint.
- `.planning/REQUIREMENTS.md` - `CAP-01`, `CAP-02`, and `CAP-03` requirements for native/mobile capture hardening.
- `.planning/ROADMAP.md` - Phase 41 goal and success criteria.
- `.planning/STATE.md` - Current v2.6 state and deferred native/mobile/provider boundaries.

### Prior Phase Context
- `.planning/phases/23-advanced-work-board-and-native-capture/23-CONTEXT.md` - Original work board/native capture decisions if present in this repo.
- `.planning/phases/23-advanced-work-board-and-native-capture/23-01-SUMMARY.md` - Delivered capture queue and promotion behavior if present in this repo.
- `.planning/phases/34-semantic-knowledge-search/34-CONTEXT.md` - Semantic + lexical knowledge search decisions.
- `.planning/phases/34-semantic-knowledge-search/34-01-SUMMARY.md` - Delivered search behavior and verification evidence.
- `.planning/phases/40-trusted-local-knowledge-bridge/40-CONTEXT.md` - Recent trusted source evidence, status, queue, and deterministic verification patterns.
- `.planning/phases/39-enterprise-connector-apply-loop/39-CONTEXT.md` - Recent connector evidence and readiness surfacing pattern.

### Existing Code Evidence
- `packages/shared/src/validators/rt2-task.ts` - Existing inbound draft source enum, create inbound draft validator, promote validator, and failure validator.
- `packages/shared/src/types/rt2-task.ts` - Existing `Rt2CaptureDraftSummary`, `Rt2CaptureQueue`, source, and status contracts to extend.
- `packages/db/src/schema/rt2_work_board.ts` - Existing `rt2_capture_drafts` table, duplicate lookup, status, permission, and audit trail fields.
- `packages/db/src/migrations/0093_rt2_phase23_work_board_capture.sql` - Current persistence baseline for work board and capture drafts.
- `server/src/routes/rt2-tasks.ts` - Existing inbound draft, capture queue, promote, fail, company access, and activity log routes.
- `server/src/services/rt2-work-board.ts` - Existing create/list/promote/fail capture draft service behavior, duplicate detection, and promotion target handling.
- `ui/src/api/rt2-tasks.ts` - Existing UI API client for inbound draft, capture queue, promotion, and failure.
- `ui/src/pages/rt2/OneLinerPage.tsx` - Existing One-Liner surface and capture entrypoint display for Slack, Teams, mobile, and native.
- `server/src/routes/rt2-hybrid-search.ts` - Existing company-scoped semantic/lexical search route and filters.
- `server/src/services/rt2-hybrid-search.ts` - Existing semantic chunk search, lexical fallback, evidence, freshness, confidence, and contradiction fields.
- `ui/src/api/rt2-search.ts` - Existing search response/client contract for semantic results and index status.
- `ui/src/pages/rt2/KnowledgePage.tsx` - Existing semantic search UI to harden for mobile layout and citation targets.
- `server/src/__tests__/rt2-task-routes.test.ts` - Existing inbound One-Liner draft route coverage.
- `server/src/__tests__/rt2-v23-route-fallback.test.ts` - Deterministic fallback coverage for native capture route contracts.
- `server/src/__tests__/rt2-phase6-intelligence.test.ts` - Existing semantic search, contradiction, and Jarvis grounding coverage.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `createOneLinerInboundDraftSchema` already accepts `slack`, `teams`, `webhook`, `mobile`, and `native` sources.
- `rt2CaptureDrafts` already stores source, channel, external user, normalized hash, parsed draft, status, duplicate link, permission status, and audit trail.
- `rt2WorkBoardService.createInboundDraft` already parses One-Liner text, computes normalized duplicate hashes, marks duplicate or permission-blocked status, and stores audit trail evidence.
- `rt2WorkBoardService.promoteCaptureDraft` already promotes drafts into task, todo, or deliverable targets and records promoted IDs.
- `rt2TaskRoutes` already logs `rt2.capture.inbound_draft_created`, `rt2.capture.draft_promoted`, and `rt2.capture.draft_failed`.
- `rt2HybridSearchService.search` already combines semantic chunks and lexical search with freshness, confidence, contradiction status, score, snippets, and evidence.
- `KnowledgePage` already renders semantic search results with filters, status cards, result chips, snippets, scores, and evidence chips.

### Established Patterns
- RT2 API routes use `/companies/:companyId/rt2/...` and call `assertCompanyAccess`.
- Shared contracts live in `packages/shared/src/types/*` and `packages/shared/src/validators/*`, then server and UI consume the same types.
- Persistence additions use Drizzle schema files plus numbered SQL migrations.
- Activity log is the accepted audit mechanism for operator-visible RT2 actions.
- Default local/CI verification must remain deterministic without live external providers or OS-specific native APIs.
- Product-facing UI should keep RealTycoon2 terminology and dense operator workflows.

### Integration Points
- Add capture source installation/signing schema near `rt2_work_board` or a new capture-specific schema file, then export it through `packages/db/src/schema/index.ts`.
- Extend shared RT2 task/capture types and validators with source installation status, signing status, inbound event evidence, semantic context, duplicate warning, and citation target fields.
- Extend `rt2WorkBoardService` with source installation listing/upsert, signature verification, enriched queue loading, semantic context lookup, and promotion metadata/audit details.
- Extend `rt2TaskRoutes` with capture source status routes and hardened inbound draft verification while preserving existing route compatibility.
- Extend `rt2TasksApi`, `queryKeys`, and `OneLinerPage` or the existing work-board/capture surface to render source installation state and enriched queue evidence.
- Extend `KnowledgePage` search result rendering for mobile-safe layout and routeable citation actions.
- Extend fallback and embedded Postgres tests around capture route contracts, persistence, promotion, and mobile search rendering.

</code_context>

<specifics>
## Specific Ideas

- Treat Phase 41 as the operational continuation of Phase 23: Phase 23 made inbound native/mobile capture queue promotion possible; Phase 41 makes it trusted, signed, source-aware, semantically contextual, and mobile-safe.
- Capture source health should answer "can this company trust and review this source now?" rather than only "does the endpoint accept a source string?"
- Semantic context belongs in the review queue as evidence for the operator, not as an automatic promotion decision.
- Mobile search hardening should preserve signal density, not create a simplified toy search.

</specifics>

<deferred>
## Deferred Ideas

- App-store native distribution, push notifications, and OS-level share extension packaging remain future native distribution scope.
- Live Slack/Teams OAuth installation and production webhook secret rotation are future connector-depth scope; Phase 41 may model deterministic signed installations.
- Automatic capture promotion without operator review remains out of scope.
- Jarvis autonomous rewrite proposal/eval guardrails belong to Phase 42.

</deferred>

---

*Phase: 41-native-and-mobile-capture-hardening*
*Context gathered: 2026-04-29*
