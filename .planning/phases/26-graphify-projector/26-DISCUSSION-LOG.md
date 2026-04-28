# Phase 26: Graphify Projector - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-27
**Phase:** 26-graphify-projector
**Areas discussed:** Graph Node Source, Incremental Refresh, Confidence Tags, Community Detection, Visualization, Graph Report

---

## Area: Graph Node Source (Daily Wiki as Graph Input)

[auto] Selected all gray areas: Graph Node Source, Incremental Refresh, Confidence Tags, Community Detection, Visualization, Graph Report

[auto] [Graph Node Source] — Q: "How should daily wiki pages become graph nodes?" → Selected: "Use daily_wiki_page nodeType with pageKey as nodeKey" (Phase 25 context)

**Notes:**
- Phase 25 already creates `rt2_v33_daily_wiki_pages` with pageKey format `daily/YYYY-MM-DD.md`
- `daily_wiki_page` nodeType already exists in RT2_GRAPH_NODE_TYPES from rt2-graph.test.ts
- nodeKey format `{nodeType}:{id}` already established in existing code

---

## Area: Incremental Refresh (GRAPH-03)

[auto] [Incremental Refresh] — Q: "How to trigger graph refresh only when daily wiki changes?" → Selected: "graph_cache hash comparison with daily wiki content" (recommended default)

**Notes:**
- `rt2_v33_graph_cache` table already exists with scopeKey, companyId, projectId, inputHash, inputWindow, lastProjectedAt
- scopeKey pattern for graph daily cache: `'graph_daily_{companyId}_{date}'`
- Hash input: combined hash of daily wiki pages + event count

---

## Area: Confidence Tags (GRAPH-02)

[auto] [Confidence Tags] — Q: "How to assign EXTRACTED/INFERRED/AMBIGUOUS confidence to edges?" → Selected: "EXTRACTED for direct event evidence, INFERRED for implied relationships, AMBIGUOUS for unverified" (recommended default)

**Notes:**
- EXTRACTED: domain event directly shows relationship (task_todo, project_task)
- INFERRED: no direct event evidence but logical implication (daily wiki page + task implicit connection)
- AMBIGUOUS: uncertain provenance or unverified by operator (Obsidian wikilink)
- Confidence rationale and evidence metadata required for all non-EXTRACTED edges

---

## Area: Community Detection (GRAPH-06)

[auto] [Community Detection] — Q: "How to implement Leiden algorithm for community detection?" → Selected: "Run Leiden in graph projection batch job, store results in rt2_v33_graph_communities" (recommended default)

**Notes:**
- Leiden algorithm runs as part of graph projection batch job, not on every event
- `rt2_v33_graph_communities` table already exists with algorithm, label, memberNodeCount, godNodeId, reportPath columns
- communityKey format: `leiden_{timestamp}`
- godNode determined by highest centrality score within community

---

## Area: Visualization (GRAPH-04)

[auto] [Visualization] — Q: "How to display graph with confidence-tagged edges?" → Selected: "Reuse existing Rt2GraphPanel Mermaid rendering with existing nodeShape/nodeStyle" (recommended default)

**Notes:**
- `Rt2GraphPanel.tsx` already has Mermaid rendering with nodeShape/nodeStyle for daily_wiki_page (amber, `{ } ` shape)
- Confidence-tagged edges can be differentiated by line style (solid=EXTRACTED, dashed=INFERRED, dotted=AMBIGUOUS)
- graph tab already exists in the UI — Phase 26 adds daily_wiki_page nodes to it

---

## Area: Graph Report (GRAPH-05)

[auto] [Graph Report] — Q: "How to generate and store GRAPH_REPORT.md?" → Selected: "Store in rt2_v33_graph_reports markdown column, return via API" (recommended default)

**Notes:**
- `rt2_v33_graph_reports` table already exists with markdown column
- Report contents: node/edge count, confidence distribution, community summary, god node list
- API endpoint already exists at GET `/companies/:companyId/rt2/graph-report?projectId=...`
- Phase 26 extends refreshGraphReport() to include community detection results

---

## Claude's Discretion

- Leiden algorithm implementation library selection (existing community detection logic)
- INFERRED/AMBIGUOUS confidence assignment criteria details
- GRAPH_REPORT.md markdown template format
- graph batch job scheduling (cron/timer vs on-demand)

## Deferred Ideas

- Cross-company knowledge federation — outside trusted ecosystem scope
- Phase 29 Linting reads wiki content — batch scan pattern, not on-write trigger

---

*Discussion log complete: 2026-04-27*
