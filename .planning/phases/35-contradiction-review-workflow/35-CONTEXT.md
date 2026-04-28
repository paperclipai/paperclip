# Phase 35: Contradiction Review Workflow - Context

**Gathered:** 2026-04-28
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 35 turns knowledge conflicts into reviewable contradiction candidates with deterministic reason codes, raw evidence, optional provider explanations, operator resolution decisions, and audit/search freshness effects. It builds on Phase 34 semantic search and the existing deterministic wiki lint path. It does not implement Jarvis answer composition or the full knowledge operations dashboard.

</domain>

<decisions>
## Implementation Decisions

### Candidate Generation
- **D-01:** Use existing `rt2WikiLintService` `embedding_consistency` issues as the deterministic candidate source for Phase 35.
- **D-02:** Store contradiction candidates in additive RT2 tables rather than mutating wiki/graph source rows.
- **D-03:** Every candidate must retain raw evidence snippets, source IDs/keys, deterministic reason code, confidence, and optional provider explanation placeholder.

### Operator Resolution
- **D-04:** Operator decisions are exactly `false_positive`, `accept_newer`, `keep_older`, and `request_follow_up`.
- **D-05:** Resolution creates a separate audit/resolution row and writes activity log evidence.
- **D-06:** Follow-up work can be represented by an optional linked issue ID; automatic issue creation is not required in this phase.

### Search Freshness
- **D-07:** Open candidates mark related semantic chunks stale so search results surface freshness risk.
- **D-08:** Resolution marks the related semantic chunks fresh again.

### Operator Surface
- **D-09:** First review surface belongs in `KnowledgePage` Bridge workflow, next to existing knowledge bridge conflict review.
- **D-10:** UI should show raw evidence and deterministic reason code before resolution actions.

### the agent's Discretion
- Exact candidate title copy, UI ordering, and provider explanation shape are implementation discretion as long as raw evidence and reason codes remain first-class.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

- `.planning/PROJECT.md` - RT2-first identity and approval-first knowledge loop.
- `.planning/REQUIREMENTS.md` - CONTRA-01 through CONTRA-04.
- `.planning/ROADMAP.md` - Phase 35 goal and success criteria.
- `.planning/phases/34-semantic-knowledge-search/34-CONTEXT.md` - Search freshness and contradiction-status placeholders.
- `server/src/services/rt2-wiki-lint.ts` - Deterministic contradiction signal source.
- `server/src/services/rt2-semantic-index.ts` - Semantic chunk freshness integration.
- `ui/src/pages/rt2/KnowledgePage.tsx` - Operator review surface.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `analyzeWikiPageConsistency` already identifies polarity conflicts between related daily wiki pages.
- `activity-log` already provides audit trail entries for knowledge workflows.
- Semantic index chunks already carry `freshness` and source IDs, making stale/fresh reflection additive.

### Established Patterns
- RT2 knowledge changes use company-scoped routes with `assertCompanyAccess`.
- Knowledge bridge UI already contains review/resolve controls; contradiction review can follow that pattern.

### Integration Points
- Add DB tables under `packages/db/src/schema`.
- Add route under `/companies/:companyId/rt2/contradictions`.
- Add UI API methods to `rt2KnowledgeApi`.

</code_context>

<specifics>
## Specific Ideas

- Keep provider-backed explanation optional; the deterministic reason code is the auditable source.
- Do not silently rewrite wiki/graph content from a contradiction resolution.

</specifics>

<deferred>
## Deferred Ideas

- Jarvis contradiction warnings are Phase 36.
- Operations dashboard and health gate are Phase 37.

</deferred>

---

*Phase: 35-contradiction-review-workflow*
*Context gathered: 2026-04-28*
