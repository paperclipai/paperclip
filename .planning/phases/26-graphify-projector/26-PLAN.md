# Phase 26: Graphify Projector — Implementation Plan

**Phase:** 26-graphify-projector
**Status:** Ready for execution
**Created:** 2026-04-27

## Context Summary

Phase 25 (Daily Wiki Projector) creates `rt2_v33_daily_wiki_pages` table with daily wiki pages per company/date/user.
Phase 26 extends knowledge projector to project these daily wiki pages into a knowledge graph with confidence-tagged edges.

**Decisions from 26-CONTEXT.md:**
- D-01: `daily_wiki_page` nodeType with pageKey as nodeKey
- D-04: graph_cache hash comparison for incremental refresh
- D-07-09: EXTRACTED/INFERRED/AMBIGUOUS confidence semantics
- D-10-12: Leiden algorithm in batch job, stored in `rt2_v33_graph_communities`
- D-13-14: GRAPH_REPORT.md stored in `rt2_v33_graph_reports.markdown`
- D-15-16: Reuse existing Rt2GraphPanel Mermaid rendering

---

## Wave-Based Implementation

### Wave A: GRAPH-01 — daily_wiki_page nodes in projectDailyEvent()

**File:** `server/src/services/rt2-knowledge-projector.ts`

Add a new function `projectDailyWikiPageToGraph()` and call it from `projectEvent()` after `projectDailyEvent()`.
The function reads from `rt2_v33_daily_wiki_pages` and creates `daily_wiki_page` graph nodes.

**Key details:**
- nodeKey: `daily_wiki_page:{pageKey}` (e.g., `daily_wiki_page:daily/2026-04-27.md`)
- nodeType: `daily_wiki_page` (already in RT2_GRAPH_NODE_TYPES)
- sourceId: row.id
- label: title derived from date + userId

**Changes to `projectEvent()`:** After `projectDailyEvent(event)`, call `projectDailyWikiPageToGraph(event)`.

### Wave B: GRAPH-02 — EXTRACTED/INFERRED/AMBIGUOUS confidence on edges

**Files:** `server/src/services/rt2-knowledge-projector.ts`

1. Modify `upsertEdge()` to accept confidence as a parameter (currently hardcoded to EXTRACTED).
2. Add helper `confidenceForEdge(event, sourceType, targetType)` that returns:
   - `EXTRACTED` for edges directly created from domain events (existing behavior)
   - `INFERRED` for edges created from daily wiki page connections where no direct event evidence exists
   - `AMBIGUOUS` for wikilink edges from Obsidian vault imports
3. Update `projectGraphEvent()` to pass confidence to `upsertEdge()`.
4. Add `projectDailyWikiPageEdges()` that creates INFERRED edges between daily wiki pages and related task nodes.

**Confidence assignment rules:**
- Domain event edges → EXTRACTED (confidence=1.00, rationale: direct event evidence)
- Daily wiki to task implied connections → INFERRED (confidence=0.70, rationale: "implied by daily activity pattern")
- Obsidian wikilinks → AMBIGUOUS (confidence=0.50, rationale: "unverified operator-supplied link")

### Wave C: GRAPH-03 — incremental refresh via graph_cache hash

**File:** `server/src/services/rt2-knowledge-projector.ts`

1. Add `computeDailyWikiHash(companyId)` that reads all `rt2_v33_daily_wiki_pages` for a company and returns a combined hash.
2. Add `shouldRefreshGraph(companyId, projectId)` that compares current hash against stored hash in `rt2_v33_graph_cache` with scopeKey `graph_daily_{companyId}_{date}`.
3. Modify `projectDailyWikiPageToGraph()` to call `shouldRefreshGraph()` before projecting.
4. Update `rt2_v33_graph_cache` after successful projection.

**Hash input:** SHA-256 of JSON stringified `{ pageCount, latestUpdatedAt, eventCount }` for the company's daily wiki pages.

### Wave D: GRAPH-06 + GRAPH-05 — Leiden community detection + extended graph report

**File:** `server/src/services/rt2-knowledge-projector.ts`

1. Modify `refreshGraphReport()` to also call `detectCommunities()` (imported from `rt2-task-mesh.ts`).
2. After community detection, compute godNode per community (highest centrality node).
3. Store community results in `rt2_v33_graph_communities` table.
4. Extend markdown output in `refreshGraphReport()` to include:
   - Community list with member counts
   - God node per community
   - Confidence distribution (EXTRACTED/INFERRED/AMBIGUOUS counts)
   - Node/edge totals

**Note:** The existing `detectCommunities()` in rt2-task-mesh.ts uses label propagation (simplified Leiden). Per D-10, we use this existing implementation and the communityKey format `leiden_{timestamp}`.

### Wave E: GRAPH-04 — Verify Rt2GraphPanel compatibility

**File:** `ui/src/components/Rt2GraphPanel.tsx`

Check that existing Mermaid rendering already handles `daily_wiki_page` nodeType with amber color and `{ } ` shape.
No code changes expected if existing code already covers this (per D-15).

---

## Implementation Order

1. **Wave A** (GRAPH-01) — Add daily_wiki_page nodes, modify projectEvent() to call projector
2. **Wave B** (GRAPH-02) — Add confidence parameter to upsertEdge, update projectGraphEvent, add INFERRED edge creation
3. **Wave C** (GRAPH-03) — Add graph_cache hash comparison for incremental refresh
4. **Wave D** (GRAPH-05 + GRAPH-06) — Extend refreshGraphReport with community detection + markdown
5. **Wave E** (GRAPH-04) — Verify Rt2GraphPanel compatibility
6. **Verification** — Run `pnpm typecheck && pnpm test`

---

## Files to Modify

| File | Changes |
|------|---------|
| `server/src/services/rt2-knowledge-projector.ts` | Add `projectDailyWikiPageToGraph()`, modify `upsertEdge()`, add hash comparison, extend `refreshGraphReport()` |
| `packages/db/src/schema/rt2_v33_graph_projection.ts` | No changes (schema already supports all required fields) |

---

## Testing Notes

- `pnpm typecheck` — all types must be clean
- `pnpm test` — existing tests must pass
- Graph projector is event-driven: re-running `projectEvent()` on same events should be idempotent (no duplicate nodes/edges)

---

*Plan created: 2026-04-27*