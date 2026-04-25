# Phase 12: Jarvis Runtime and Change Management - Context

**Gathered:** 2026-04-25
**Status:** Ready for planning

<domain>
## Phase Boundary

이 Phase는 Jarvis Shadow/Co-Pilot/Auto 전환을 운영자가 신뢰할 수 있는 workflow로 만든다. 범위는 manager review, Auto policy boundary, expected deliverable 기반 task reverse design, runtime skill attachment를 governed Jarvis capability로 노출하는 것이다.

</domain>

<decisions>
## Implementation Decisions

### Manager Review
- **D-01:** Shadow/Co-Pilot/Auto 품질평가는 새 별도 저장소가 아니라 기존 `rt2_quality_scores`를 manager review queue로 컴파일한다.
- **D-02:** review item은 task title, deliverable type/status, score, expected gold delta, policy band, rationale, manager decision을 한 번에 보여줘야 한다.
- **D-03:** 승인/거절은 기존 quality score row를 finalize하고 active 여부를 바꾸는 lightweight action으로 처리한다.

### Auto Policy
- **D-04:** Auto mode는 base price와 threshold band로 판단하고, band 밖이면 Co-Pilot pending review로 라우팅한다.
- **D-05:** policy decision은 API 응답에 명시적으로 포함해 "왜 Auto였는지/왜 Co-Pilot인지"를 UI와 테스트에서 검증 가능하게 한다.

### Reverse Design
- **D-06:** Jarvis reverse design은 예상 deliverable에서 task proposal과 rationale을 만들고, 근거는 `rt2_reverse_design_runs`에 남긴다.
- **D-07:** 이번 Phase에서는 실제 task를 자동 생성하지 않고 traceable proposal까지만 생성한다. 실제 생성/승인은 다음 capability에서 확장 가능하다.

### Runtime Skill Capability
- **D-08:** runtime skill injection은 숨은 adapter detail이 아니라 `Jarvis skill capability`로 노출한다.
- **D-09:** skill capability 생성은 `rt2_runtime_skill_injections` row와 `jarvis_skill_capability` approval request를 함께 만든다.

### the agent's Discretion
- UI는 기존 `Rt2QualityPanel`, `Rt2GovernancePanel`에 최소 증분으로 붙인다.
- 새 DB truth는 기존 Drizzle schema와 migration에 맞추되, 불필요한 신규 도메인 테이블은 만들지 않는다.

</decisions>

<canonical_refs>
## Canonical References

### Project Direction
- `.planning/ROADMAP.md` — Phase 12 목표와 성공 기준.
- `.planning/REQUIREMENTS.md` — `JARVIS-01`부터 `JARVIS-04`까지의 acceptance criteria.
- `.planning/DEVPLAN-ALIGNMENT.md` — Jarvis/change-management gap 근거.
- `AGENTS.md` §14, §18, §19 — Jarvis mode, approval gate, governance rules.

### Existing Implementation
- `server/src/services/rt2-auto-evaluation.ts` — Shadow/Co-Pilot/Auto quality evaluation.
- `server/src/services/rt2-advanced-ai.ts` — reverse design, process mining, runtime skill injection baseline.
- `server/src/services/rt2-governance.ts` — approval and activity log infrastructure.
- `ui/src/components/Rt2QualityPanel.tsx` — quality cockpit extension point.
- `ui/src/components/Rt2GovernancePanel.tsx` — governance/runtime extension point.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `rt2QualityScores`: quality mode, score, manager decision, auto band snapshot을 이미 보관한다.
- `approvals`: high-impact Jarvis capability request를 별도 schema 없이 수용할 수 있다.
- `rt2ReverseDesignRuns`: expected deliverable에서 task rationale을 남기기에 적합하다.
- `rt2RuntimeSkillInjections`: runtime skill attachment lifecycle을 이미 표현한다.

### Established Patterns
- company-scoped Express route + `assertCompanyAccess` 패턴을 유지한다.
- UI는 React Query 기반 panel query/mutation/invalidate 패턴을 따른다.
- 테스트는 embedded Postgres route test로 API contract를 검증한다.

### Integration Points
- `rt2-auto-evaluation` route에 Jarvis manager review와 policy preview endpoint를 추가한다.
- `rt2-advanced-ai` route에 reverse-design task proposal과 skill capability endpoint를 추가한다.
- `Rt2QualityPanel`과 `Rt2GovernancePanel`에 operator-visible runtime evidence를 붙인다.

</code_context>

<specifics>
## Specific Ideas

- 운영자가 raw DB를 보지 않아도 Shadow/Co-Pilot/Auto 평가의 근거와 delta를 이해해야 한다.
- Auto가 실패한 것이 아니라 policy 밖이면 Co-Pilot으로 라우팅된다는 점을 명확히 보여준다.

</specifics>

<deferred>
## Deferred Ideas

- reverse-designed proposal을 실제 task 생성/approval flow까지 연결하는 것은 후속 Phase 또는 backlog로 둔다.
- runtime skill effectiveness를 실제 execution outcome과 자동 연결하는 것은 이번 Phase 밖이다.

</deferred>

---

*Phase: 12-jarvis-runtime-and-change-management*
*Context gathered: 2026-04-25*
