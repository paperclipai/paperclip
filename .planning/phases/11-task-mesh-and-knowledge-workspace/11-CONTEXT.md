# Phase 11: Task Mesh and Knowledge Workspace - Context

**수집일:** 2026-04-25
**상태:** 계획 및 실행 완료

<domain>

## Phase Boundary

이 Phase는 개발기획서의 Task Mesh와 누적 지식 workspace gap을 닫는다. 범위는 project-scoped Task Mesh의 7개 view, task node의 산출물/owner/execution/quality/gold/knowledge evidence, 운영자용 wiki index/log/topic page, Obsidian-compatible vault export preview, God Node/surprising connection/ambiguous warning 표시, 그리고 projector 재개 가능성 확인이다.

</domain>

<decisions>

## Implementation Decisions

### Task Mesh

- **D-01:** 새 graph 시스템을 만들지 않고 기존 `rt2-task-mesh` graph route와 `Rt2GraphPanel`을 Task Mesh read model로 확장한다.
- **D-02:** 7개 view는 `hierarchy`, `dependency`, `timeline`, `collaborator`, `deliverable`, `knowledge`, `economy`로 고정한다.
- **D-03:** Task node는 raw DB를 보지 않아도 `deliverableCount`, `ownerCount`, `latestExecutionState`, `qualityStatus`, `goldEstimate`, `knowledgeRefs`, `status`를 노출한다.
- **D-04:** dependency/community 정보는 기존 edge/community 계산을 재사용하고, ambiguous/stale/missing 상태는 warning으로 우선 표시한다.

### Knowledge Workspace

- **D-05:** 기존 event projector가 만든 `index.md`, `log.md`, topic page를 operator wiki source로 사용한다.
- **D-06:** markdown 파일은 primary write path가 아니라 export/inspection output이다. Obsidian-compatible vault export는 API가 page rows를 안전한 path/content bundle로 반환한다.
- **D-07:** Knowledge top-level page의 graph tab은 placeholder가 아니라 실제 `Rt2GraphPanel`에 연결한다.
- **D-08:** vault export는 frontmatter에 `rt2_page_key`, `rt2_page_type`, `rt2_company_id`, `rt2_updated_at`, `rt2_source_event_ids`를 포함한다.

### Graph Evidence

- **D-09:** Graph report는 God Node, surprising connection, ambiguous edge, stale/missing warning을 직접 반환한다.
- **D-10:** graph node/edge type은 Phase 5 projector가 이미 쓰는 `deliverable`, `actor`, `event`, `actor_event`, `event_entity`까지 shared contract에 포함한다.

### Projector Resume

- **D-11:** `projectAll`은 기존 projector processed-event table을 기준으로 중복 처리를 피하고 `pendingEvents`, `lastProjectedAt`을 반환한다.

</decisions>

<canonical_refs>

## Canonical References

### Product 기준

- `.planning/REQUIREMENTS.md` - `MESH-01`, `MESH-02`, `KNOW-01`, `KNOW-02`, `KNOW-03`, `KNOW-04` 완료 기준.
- `.planning/DEVPLAN-ALIGNMENT.md` - 개발기획서 대비 Task Mesh/Knowledge gap 기준.
- `AGENTS.md` - cumulative wiki, graph provenance, markdown non-primary-write-path, RealTycoon2 identity.

### Existing implementation

- `server/src/services/rt2-task-mesh.ts` - Task Mesh graph read model.
- `server/src/routes/rt2-task-mesh.ts` - project graph/report route.
- `server/src/services/rt2-knowledge-projector.ts` - wiki/graph projector, replay-safe projection.
- `server/src/routes/rt2-knowledge.ts` - wiki page/project/export routes.
- `packages/shared/src/types/rt2-graph.ts` - graph and Task Mesh shared contract.
- `packages/shared/src/types/rt2-knowledge.ts` - wiki and vault export contract.
- `ui/src/components/Rt2GraphPanel.tsx` - Task Mesh UI.
- `ui/src/pages/rt2/KnowledgePage.tsx` - Knowledge workspace shell.

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets

- `rt2TaskMeshService.getProjectGraph` already built project/task/todo/wiki/deliverable nodes and extracted edges.
- `rt2KnowledgeProjectorService.projectEvent` already used the domain-event projector guard.
- `Rt2GraphPanel` already had Mermaid graph rendering and list/timeline/deliverable variants.
- `KnowledgePage` already selected a project and had daily/wiki/graph tab shell.

### Integration Points

- Extend graph shared types and constants before server/UI use.
- Add vault export route under existing `rt2KnowledgeRoutes`.
- Reuse `issueWorkProducts`, `rt2V33TaskParticipants`, `rt2V33ExecutionAttempts`, `rt2QualityScores`, and daily wiki pages for Task Mesh evidence.

</code_context>

<specifics>

## Specific Ideas

- 운영자는 DB를 보지 않고도 Task Mesh에서 “누가, 무엇을, 어떤 산출물/품질/보상/지식 근거로 진행 중인지”를 볼 수 있어야 한다.
- Obsidian 호환은 파일 시스템을 business truth로 바꾸는 것이 아니라, 검사 가능한 export bundle로 제공한다.

</specifics>

<deferred>

## Deferred Ideas

- Obsidian 양방향 sync와 실제 local vault writer는 별도 approval/storage 정책이 필요하므로 후속 phase로 미룬다.
- 대규모 graph layout/interactive canvas는 현재 Mermaid/list view가 부족해질 때 별도 UI phase로 다룬다.

</deferred>

---

*Phase: 11-task-mesh-and-knowledge-workspace*
*Context gathered: 2026-04-25*
