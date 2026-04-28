# Phase 8: Dev Plan Alignment Baseline - Context

**수집일:** 2026-04-25  
**상태:** planning 준비 완료

<domain>
## Phase 경계

Phase 8은 v2.1의 첫 정식 Phase다. 이 Phase는 업로드된 RealTycoon2 개발기획서를 현재 앱 capability에 매핑하는 경량 내부 adoption checklist를 만든다. 상태는 shipped, partial, missing으로 나눈다.

이 Phase는 rebuild가 아니다. 운영자와 이후 Phase 작업자가 앱과 planning docs에서 확인할 수 있는 지속적인 기준선을 만드는 것이 목적이다.

</domain>

<decisions>
## 구현 결정

### Baseline Shape
- **D-01:** 초기 adoption category의 source of truth는 기존 `.planning/DEVPLAN-ALIGNMENT.md` audit로 둔다.
- **D-02:** `ENT-04`는 앱이 map을 포함해야 하므로 checklist를 planning markdown에만 두지 않고 RT2 web shell 안에 보여준다.
- **D-03:** 첫 구현은 static/lightweight로 둔다. 운영자가 live editable scoring을 실제로 필요로 하기 전에는 새 DB table을 추가하지 않는다.

### Product Framing
- **D-04:** RealTycoon2-first wording을 사용한다. Paperclip, Multica, wikiLLM, Graphify, Obsidian은 reference ingredient로만 언급한다.
- **D-05:** status bucket은 `shipped`, `partial`, `missing`으로 두고, 필요한 경우 Phase 9-13으로 연결한다.

### Scope Guard
- **D-06:** Phase 8은 floating capture, daily cockpit, task mesh, Jarvis rollout, enterprise rollout feature를 구현하지 않는다. 그 gap을 보이게 만들고 추적 가능하게 한다.

### agent 재량
기존 RT2 shell pattern에 맞고 normal navigation에서 checklist가 보인다면 가장 단순한 UI 위치와 component 구조를 선택해도 된다.

</decisions>

<canonical_refs>
## 기준 참조

### Product and Milestone
- `AGENTS.md` — RealTycoon2 identity, source-of-truth order, Superpowers/gstack default 금지, RT2 domain model.
- `.planning/DEVPLAN-ALIGNMENT.md` — 개발기획서 gap audit와 v2.1 rationale.
- `.planning/REQUIREMENTS.md` — v2.1 requirements. `ENT-04`가 Phase 8 범위다.
- `.planning/ROADMAP.md` — Phase 8-13 계획과 성공 기준.
- `.planning/STATE.md` — 현재 v2.1 위치.

### Current UI
- `ui/src/App.tsx` — RT2 route registration과 company-prefixed redirect.
- `ui/src/components/Sidebar.tsx` — 주요 RT2 navigation.
- `ui/src/components/CommandPalette.tsx` — keyboard command navigation.
- `ui/src/pages/rt2/ControlPlanePage.tsx` — 기존 company-level RT2 page pattern.

</canonical_refs>

<code_context>
## 기존 코드 인사이트

### 재사용 자산
- `useBreadcrumbs`는 RT2 page breadcrumb 설정에 사용된다.
- RT2 page는 `ui/src/pages/rt2` 아래 route-level React component로 존재한다.
- Sidebar와 command palette는 이미 RT2 route를 묶고 있어 discovery point로 적합하다.

### 기존 패턴
- Company-prefixed route는 `ui/src/App.tsx`에 등록되고, top-level RT2 path에는 unprefixed redirect가 있다.
- `ui/src/lib/company-routes.ts`는 어떤 board route가 company route로 취급되는지 정의한다.
- RT2 page는 필요한 경우 static section과 API-backed panel을 함께 사용한다.

### Integration Points
- `/plan-alignment` 같은 새 route를 추가한다.
- prefixed/unprefixed routing에 등록한다.
- RT2 sidebar와 command palette에 추가한다.

</code_context>

<specifics>
## 구체 아이디어

첫 화면은 “업로드된 개발기획서가 현재 앱에 얼마나 반영되어 있는가?”에 답해야 한다. shipped/partial/missing count를 보여주고, missing work를 upcoming v2.1 phase에 연결한다.

</specifics>

<deferred>
## 미룬 항목

- company-specific adoption scoring을 persisted editable checklist로 만드는 작업은 운영자가 static baseline을 사용한 뒤 판단한다.
- static drift가 문제가 될 때 automated code scanning으로 status refresh를 추가한다.

</deferred>

---
*Phase: 08-dev-plan-alignment-baseline*  
*Context gathered: 2026-04-25*
