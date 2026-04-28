# Phase 15: Identity Shell Hardening - Context

**Gathered:** 2026-04-25 (auto)
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 15는 Paperclip/Multica를 RealTycoon2 내부 엔진과 adapter compatibility로 숨기고, 사용자가 보는 프론트엔드 shell, navigation, command palette, 주요 운영 패널의 제품 정체성을 RealTycoon2/Jarvis/업무 용어로 고정한다.
</domain>

<decisions>
## Implementation Decisions

### 제품 정체성
- **D-01:** 사용자에게 보이는 제품명은 RealTycoon2다. Paperclip/Multica는 제품명, 메뉴명, 화면 설명으로 노출하지 않는다.
- **D-02:** AI 실행자는 product-facing copy에서 `Agent`보다 `Jarvis`로 표현한다. 내부 타입, API path, package name은 이번 phase에서 강제 rename하지 않는다.

### 업무 용어
- **D-03:** `Issue`는 product-facing copy에서 `Task`, `작업`, `To-Do`로 감싼다. `/issues` route와 `issuesApi`는 compatibility layer로 유지한다.
- **D-04:** `Workspace`는 사용자에게 기술 작업공간으로 드러나야 하는 예외 화면을 제외하고 `실행 환경`, `프로젝트 환경`, `작업 실행`으로 번역한다.

### 실행 범위
- **D-05:** 이번 phase는 shell hardening이다. Trello형 메인 업무 보드 전환은 Phase 16으로 넘기고, Phase 15에서는 그 보드가 Paperclip처럼 보이지 않도록 terminology 기반을 정리한다.
- **D-06:** 테스트 fixture, package import, DB schema, server internal env/config의 Paperclip/issue/agent 명칭은 엔진 호환 계층으로 남긴다.

### the agent's Discretion
- 사용자 질문 없이 `--auto` 기본값을 적용했다. UI copy는 한국어 우선, 코드 식별자는 기존 호환성을 유지한다.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project Identity
- `AGENTS.md` — RealTycoon2 identity, Paperclip/Multica usage policy, naming policy.
- `.planning/PROJECT.md` — v2.2 milestone intent and product truth.
- `.planning/REQUIREMENTS.md` — `ALIGN-01`, `IDENTITY-01`, `IDENTITY-02` acceptance scope.
- `.planning/DEVPLAN-ALIGNMENT.md` — current sync score and remaining identity gaps.

### Roadmap
- `.planning/ROADMAP.md` — Phase 15 boundary and Phase 16 separation.
- `.planning/STATE.md` — current active phase and next command.
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `ui/src/components/Sidebar.tsx` — primary product navigation already partially RT2-branded.
- `ui/src/components/CommandPalette.tsx` — main cross-app discovery surface; still had visible `Agents`, `Projects`, `Create new agent`.
- `ui/src/components/SidebarAgents.tsx` — Jarvis section can wrap internal agent routes without changing route compatibility.
- `ui/src/components/SidebarProjects.tsx` — project sidebar can keep route compatibility while changing visible section labels.
- `ui/src/pages/Agents.tsx` — Jarvis management page still exposes `Agents` copy and should be product-facing hardened.

### Established Patterns
- Internal imports from `@paperclipai/*` and route paths like `/issues` and `/agents` are widespread and should not be renamed wholesale in this phase.
- RT2-specific pages already exist under `ui/src/pages/rt2` and components named `Rt2*`.

### Integration Points
- Command palette actions use dialog context (`openNewAgent`, project navigation) and must retain behavior while changing labels.
- Sidebar section labels are pure presentation and safe to change.
</code_context>

<specifics>
## Specific Ideas

사용자는 “엔진만 Paperclip+Multica여야지 실제 모습이 Paperclip과 Multica의 모습이어서는 안 된다”고 명시했다. Phase 15는 이 우려를 직접 해소해야 한다.
</specifics>

<deferred>
## Deferred Ideas

- Trello 기반 완전한 RealTycoon2 메인 업무 보드 전환은 Phase 16에서 구현한다.
- 내부 package rename, DB schema rename, API route migration은 별도 migration phase가 필요하다.
</deferred>

---

*Phase: 15-identity-shell-hardening*
*Context gathered: 2026-04-25*
