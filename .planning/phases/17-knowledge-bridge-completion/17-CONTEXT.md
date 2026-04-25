# Phase 17: Knowledge Bridge Completion - Context

**Gathered:** 2026-04-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 17은 Obsidian/wikiLLM/Graphify reference를 RealTycoon2 운영자 workflow로 감싼다. 범위는 company-level `Knowledge` route에서 projector 실행, Obsidian-compatible vault export, vault import preview, graph report, evidence status를 하나의 검수 흐름으로 제공하는 것이다.

</domain>

<decisions>
## Implementation Decisions

### Source of Truth
- **D-01:** DB/event projector가 계속 primary source of truth다. Markdown vault는 inspection/export/import-preview artifact이며 business truth를 직접 덮어쓰지 않는다.
- **D-02:** `import`는 이번 phase에서 안전한 preview contract로 제공한다. 로컬 Obsidian directory writer나 양방향 sync는 approval/storage 정책이 필요한 별도 phase다.

### Operator Workflow
- **D-03:** `Knowledge` page에 운영자 브리지 view를 추가하고 projector 실행, vault export, import preview, graph report confidence, evidence status를 한 화면에서 이어지게 한다.
- **D-04:** Evidence status는 `ready`, `missing`, `stale`, `ambiguous`로 표시한다. Graph edge confidence의 `EXTRACTED`, `INFERRED`, `AMBIGUOUS`와 함께 검수 가능해야 한다.

### Product Identity
- **D-05:** UI copy는 RealTycoon2 지식 운영 흐름으로 표현한다. `wikiLLM`, `Graphify`, `Obsidian`은 reference/compatibility 맥락에서만 언급하고 제품 본체처럼 보이게 하지 않는다.

</decisions>

<canonical_refs>
## Canonical References

### Project Truth
- `.planning/PROJECT.md` - RealTycoon2 identity, event/projector direction, v2.2 milestone goal.
- `.planning/REQUIREMENTS.md` - `KNOW-01` acceptance requirement.
- `.planning/ROADMAP.md` - Phase 17 boundary and success criteria.
- `AGENTS.md` - RealTycoon2-first identity and knowledge graph rules.

### Prior Knowledge Decisions
- `.planning/phases/05-wikillm-and-graphify-knowledge-core/05-CONTEXT.md` - cumulative wiki and provenance-aware graph projection decisions.
- `.planning/phases/11-task-mesh-and-knowledge-workspace/11-CONTEXT.md` - vault export bundle and graph workspace decisions.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `server/src/services/rt2-knowledge-projector.ts` - wiki projection, graph projection, vault export service.
- `server/src/routes/rt2-knowledge.ts` - company-scoped knowledge routes.
- `ui/src/pages/rt2/KnowledgePage.tsx` - company-level knowledge shell.
- `ui/src/components/Rt2GraphPanel.tsx` - graph report and evidence-backed task mesh display.
- `packages/shared/src/types/rt2-knowledge.ts` - shared wiki/vault contracts.

### Integration Points
- Add a safe vault import preview route under `/api/companies/:companyId/rt2/knowledge`.
- Extend `KnowledgePage` instead of creating a separate product surface.
- Keep route authorization through `assertCompanyAccess`.

</code_context>

<specifics>
## Specific Ideas

운영자는 먼저 projection을 갱신하고, 준비된 vault export를 확인한 뒤, 같은 bundle을 import preview로 검증하고, graph report confidence/evidence status를 확인할 수 있어야 한다.

</specifics>

<deferred>
## Deferred Ideas

- 실제 Obsidian local vault writer.
- 양방향 sync와 conflict resolution.
- Native filesystem connector 배포.

</deferred>

---

*Phase: 17-knowledge-bridge-completion*
*Context gathered: 2026-04-25*
