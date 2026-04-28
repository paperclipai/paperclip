# Phase 26: Graphify Projector - Context

**Gathered:** 2026-04-27
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 26는 daily wiki page content와 task metadata를 기반으로 knowledge graph을 projection한다. confidence-tagged edge(EXTRACTED/INFERRED/AMBIGUOUS), incremental refresh(graph_cache hash), community detection(Leiden algorithm), GRAPH_REPORT.md 생성을 포함한다. Phase 25 daily wiki projector가 완료된后才能 graph projector가 daily wiki content를 읽는다.

</domain>

<decisions>
## Implementation Decisions

### Graph Node Source
- **D-01:** Phase 25의 `rt2_v33_daily_wiki_pages` 테이블을 graph node 생성에 활용한다. `daily_wiki_page` node type으로 `daily/YYYY-MM-DD.md` pageKey를 nodeKey로 사용한다.
- **D-02:** 기존 `projectGraphEvent`는 event-driven projection을 유지하되, daily wiki page node를 추가하기 위해 `projectDailyEvent`에서 호출하는 구조를 활용한다.
- **D-03:** graph nodeKey format: `{nodeType}:{id}` (예: `daily_wiki_page:daily/2026-04-27.md`, `task:{taskId}`)

### Incremental Refresh (GRAPH-03)
- **D-04:** graph_cache hash comparison으로 daily wiki 변경 시에만 graph을 재projection한다. hash input: daily wiki page들의 combined hash + event count.
- **D-05:** `rt2_v33_graph_cache` 테이블의 `scopeKey`를 `'graph_daily_{companyId}_{date}'` 형식으로 사용.
- **D-06:** daily projector 실행 → daily wiki page 생성 → graph_cache hash 갱신 → graph projector trigger 순서.

### Confidence Tags (GRAPH-02)
- **D-07:** EXTRACTED: domain event에서 직접 추출된 relationship (예: `task_todo`, `project_task`)
- **D-08:** INFERRED: 명시적 event evidence는 없지만 logic으로 추론된 relationship (예: daily wiki page와 task의 암묵적 연결)
- **D-09:** AMBIGUOUS: provenance가 불확실하거나 operator가 아직 검증하지 않은 relationship (예: Obsidian wikilink)

### Community Detection (GRAPH-06)
- **D-10:** Leiden algorithm을 graph projection batch job에서 실행한다. 기존 `rt2_v33_graph_communities` 테이블에 결과를 저장한다.
- **D-11:** communityKey format: `leiden_{timestamp}` — algorithm과 관계없이 동일한 테이블 사용.
- **D-12:** godNode는 community 내에서 centrality가 가장 높은 node로 결정한다 (centrality score 기준).

### GRAPH_REPORT.md (GRAPH-05)
- **D-13:** GRAPH_REPORT.md는 DB의 `rt2_v33_graph_reports` 테이블에 `markdown` column으로 저장한다. API로 조회 시 rendering된 markdown을 반환한다.
- **D-14:** report 내용: node/edge count, confidence distribution (EXTRACTED/INFERRED/AMBIGUOUS별 count), community summary, god node list.

### Visualization (GRAPH-04)
- **D-15:** 기존 `Rt2GraphPanel.tsx`의 Mermaid rendering을 그대로 활용한다.
- **D-16:** `daily_wiki_page` node type에 대한 Mermaid shape/颜色을 기존 convention따라 적용한다 (`{ } ` stadium style, amber color).

### Agent Discretion
- Leiden algorithm的具体적 구현 library 선택 (existing community detection logic이 있으면 재사용)
- graph edge creation logic에서 INFERRED/AMBIGUOUS confidence assignment 기준
- GRAPH_REPORT.md markdown template format

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Context
- `.planning/PROJECT.md` — RT2-first identity, knowledge projection principles.
- `.planning/REQUIREMENTS.md` — GRAPH-01 ~ GRAPH-06 requirements.
- `.planning/ROADMAP.md` — Phase 26 goal and success criteria.
- `.planning/phases/25-daily-wiki-projector/25-CONTEXT.md` — Daily wiki projector decisions, rt2_v33_daily_wiki_pages table structure.
- `.planning/phases/05-wikillm-and-graphify-knowledge-core/05-CONTEXT.md` — Graph persistence, confidence semantics, evidence requirements.

### Existing Code
- `server/src/services/rt2-knowledge-projector.ts` — `projectGraphEvent()`, `upsertNode()`, `upsertEdge()`, `refreshGraphReport()`, `projectEvent()` — existing graph projection logic.
- `packages/db/src/schema/rt2_v33_graph_projection.ts` — Graph nodes, edges, cache, communities, reports schema.
- `packages/db/src/schema/rt2_v33_daily_wiki_pages.ts` — Daily wiki pages table.
- `packages/shared/src/rt2-graph.test.ts` — RT2_GRAPH_NODE_TYPES, RT2_GRAPH_EDGE_TYPES, RT2_GRAPH_CONFIDENCES constants.
- `packages/shared/src/constants.ts` — Graph constants.
- `packages/shared/src/validators/rt2-graph.ts` — Graph validators.
- `ui/src/components/Rt2GraphPanel.tsx` — Existing graph UI with Mermaid rendering, nodeShape/nodeStyle for daily_wiki_page.
- `ui/src/api/rt2-graph.ts` — Graph API client.
- `server/src/routes/rt2-task-mesh.ts` — Existing graph and graph-report endpoints.

### Schema
- `packages/db/src/migrations/0059_rt2_v33_project_graph_projection.sql` — Graph projection tables.
- `packages/db/src/migrations/0064_rt2_v33_knowledge_upgrade.sql` — Centrality, god node, report additions.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `rt2KnowledgeProjectorService.projectGraphEvent()` — already creates project/task/todo/actor/event nodes and edges with EXTRACTED confidence. Can extend to add daily_wiki_page nodes.
- `rt2KnowledgeProjectorService.upsertNode()` / `upsertEdge()` — already handle idempotent upsert with company+nodeKey unique constraint.
- `rt2KnowledgeProjectorService.refreshGraphReport()` — already computes node/edge count, confidence summary, basic markdown. Can extend with community detection.
- `rt2_v33_graph_cache` table — already exists for incremental refresh. scopeKey pattern can be extended.
- `rt2_v33_graph_communities` table — already exists with algorithm, label, memberNodeCount, godNodeId, reportPath columns.
- `Rt2GraphPanel` with Mermaid — already renders graph with nodeShape/nodeStyle for daily_wiki_page (amber, `{ } ` shape).

### Established Patterns
- Company-scoped routes use `assertCompanyAccess`.
- Graph confidence uses EXTRACTED/INFERRED/AMBIGUOUS from rt2-graph.test.ts constants.
- Daily wiki projector uses processEvent for idempotency — same contract should apply to graph projector.
- `rt2_v33_daily_wiki_pages` uses (companyId, projectId, userId, reportDate) unique constraint for upsert.

### Integration Points
- Graph projector triggered after daily wiki projector in `projectEvent()` — Phase 25 calls `projectDailyEvent`, Phase 26 extends to call graph projection.
- `rt2KnowledgeProjectorService.projectDailyEvent` is called within `projectEvent` after wiki projection — graph projector can hook here.
- Existing `rt2-task-mesh.ts` routes expose graph read endpoints — Phase 26 adds graph report and community detection.
- Phase 29 (Linting) reads wiki content — Phase 26 graph must be stable before that runs.

</code_context>

<specifics>
## Specific Ideas

- daily wiki page node는 `daily_wiki_page` type으로, pageKey가 nodeKey가 된다.
- INFERRED edge는 "implied by daily activity pattern" rationale와 evidence로 생성.
- Leiden algorithm은 community detection 결과만 저장하고, 실제 clustering은 별도 batch job으로 실행 (not on every event).
- GRAPH_REPORT.md는 project-scoped로, company-scoped daily wiki와는 다른 granularity.

</specifics>

<deferred>
## Deferred Ideas

- Phase 29 (Linting)가 nightly로 wiki content를 스캔해서 inconsistencies 탐지 — batch scan pattern.
- Cross-company knowledge federation — outside trusted ecosystem scope.

---

*Phase: 26-graphify-projector*
*Context gathered: 2026-04-27*
