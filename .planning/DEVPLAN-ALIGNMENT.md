# RealTycoon2 개발기획서 반영 현황

**검토한 원본:** `C:\Users\<user>\Downloads\RealTycoon2_DevPlan.md`  
**사용자가 언급한 PDF:** `C:\Users\<user>\Downloads\RealTycoon2_DevPlan (2).pdf`  
**검토일:** 2026-04-25  
**목적:** 현재 v2.0 앱 baseline이 업로드된 RealTycoon2 개발기획서를 얼마나 반영하고 있는지 비교하고, v2.1에서 닫아야 할 gap을 정의한다.

## 요약

현재 앱은 RealTycoon2의 핵심 방향을 상당 부분 반영했지만, 아직 개발기획서 전체보다는 web-first RT2 control surface에 더 가깝다. v2.0은 RT2 shell, One-Liner capture, deliverable definition, execution lifecycle, event stream/projector, wiki/graph record, Jarvis advice, quality mode, P&L, marketplace evidence, collaboration reward, approval, audit-capable infrastructure라는 핵심 spine을 만들었다.

2026-04-25 v2.2 Phase 18 완료 시점 재평가: v2.1 완료 직후 약 **81%**였던 개발기획서 정합성은 Phase 14-18 이후 약 **94%**로 평가한다. 핵심 데이터 모델과 운영 loop는 높게 맞춰졌고, 일일업무일지 3칸 칸반은 drag/drop lane move와 즉시 저장을 지원한다. Phase 15에서는 shell/navigation/command palette/Jarvis/task dialog/운영 설정에서 Paperclip-shaped 제품명과 Agent/Issue 중심 노출을 RealTycoon2/Jarvis/작업 용어로 감쌌다. Phase 16에서는 `/issues` 메인 표면을 RealTycoon2 업무 보드 기본값으로 바꾸고 Task/To-Do 카드, lane, drag/drop, 빠른 편집, 산출물/가격/OKR badge를 제공했다. One-Liner inbound contract도 `slack`, `teams`, `webhook`, `mobile`, `native` source와 검수 가능한 route로 확장했다. Phase 17에서는 `Knowledge > Bridge`에서 projector 실행, Obsidian-compatible vault export, import preview, graph report confidence, evidence status를 하나의 운영자 검수 흐름으로 묶었다. Phase 18에서는 P&L settlement evidence, marketplace 가격/품질/기준가/gold/협업 보상 근거, enterprise rollout SSO/template/binding/policy 검수 상태와 실제 저장값 hydrate를 완료했다. 남은 gap은 실제 외부 연동과 고급 경제 governance다.

2026-04-25 v2.3 Phase 19 검증 보강: Phase 14-18 각각의 `VALIDATION.md`가 추가되었고, embedded Postgres host init 제약으로 skipped 처리되던 Knowledge Bridge, economy/marketplace/collaboration, enterprise rollout route contract는 `server/src/__tests__/rt2-v23-route-fallback.test.ts`로 non-embedded fallback 검증 경로가 생겼다. 따라서 v2.2의 기능 완료 상태는 `validated`로 승격하고, 실제 SSO/SCIM, Obsidian bidirectional sync, settlement approval/anti-gaming, Trello advanced parity/mobile capture는 `deferred` 상태로 Phase 20-23에서 닫는다. 앱의 `PlanAlignmentPage`도 `validated`, `tech_debt`, `deferred` 상태를 함께 표시한다.

사용자 피드백 반영: Paperclip과 Multica는 엔진이어야 하며 실제 제품 모습이 되어서는 안 된다. v2.2는 "본체 Paperclip + RealTycoon 장식"처럼 보이는 모든 product-facing 표면을 제거하고, Trello식 카드/보드 상호작용을 기반으로 한 완전한 RealTycoon2 프론트엔드로 전환하는 것을 핵심 목표에 포함한다.

| 영역 | 현재 평가 | 근거 | 남은 gap |
|------|-----------|------|----------|
| RT2 identity / domain spine | 92% / validated | RT2 shell, task/deliverable/event/wiki/graph/economy/governance route와 schema 존재. 브라우저 제목, 회사 rail, sidebar, command palette, Jarvis 관리, task dialog, 운영 설정 문구를 RealTycoon2/Jarvis/작업 용어로 교체. Phase 15 `VALIDATION.md` 추가 | legacy `/issues`/`/agents` route와 internal `@paperclipai/*` package naming은 compatibility layer로 잔존 |
| Daily report cockpit | 84% / validated | 3패널 daily cockpit, OKR/KPI trace, gap flag, Trello형 drag/drop lane move. Phase 14 `VALIDATION.md` 추가 | 카드 체크리스트/정렬 등 Trello 세부 기능은 Phase 23 |
| Main work board / Trello workflow | 88% / validated | `/issues` 메인 표면이 RealTycoon2 업무 보드 기본값이며 Task/To-Do 카드, lane, drag/drop, 빠른 편집, 산출물/가격/OKR badge 표시. Phase 16 `VALIDATION.md` 추가 | 내부 route/type/API는 compatibility layer로 `Issue` 명칭을 유지 |
| One-Liner capture | 84% / deferred | floating widget, shortcut, voice draft, messenger-style route, mobile/native inbound contract와 route 검수 표면 | mobile/native inbound queue promotion은 Phase 23, native app distribution은 future |
| Knowledge wiki/graph | 87% / validated | cumulative wiki, graph projection, task mesh evidence, `Knowledge > Bridge`의 vault export/import preview와 graph report/evidence status. Phase 17 `VALIDATION.md`와 route fallback test 추가 | 실제 Obsidian local writer와 양방향 sync/conflict resolution은 Phase 21 |
| Jarvis / quality change management | 80% | Shadow/Co-Pilot/Auto, approval-linked skill capability | process mining, reverse design 고도화, runtime 운영 UX |
| Economy / marketplace / P&L | 84% / validated | ledger-backed P&L, marketplace evidence, collaboration reward, settlement evidence, actor drilldown. Phase 18 `VALIDATION.md`와 route fallback test 추가 | 가격 협상, settlement approval, reputation/anti-gaming 깊이는 Phase 22 |
| Enterprise rollout | 80% / validated | SSO/template/binding mode baseline, saved setting hydrate, ready/partial/missing evidence status. Phase 18 `VALIDATION.md`와 route fallback test 추가 | 실제 SSO metadata validation과 SCIM sync preview는 Phase 20 |

가장 큰 gap은 기본 domain entity가 아니라 adoption surface와 운영 깊이다.

- Capture는 page-based다. 개발기획서는 floating input, global shortcut, voice, mobile, Slack/Teams entry point를 기대한다.
- Daily report와 OKR/KPI는 3패널 cockpit과 Trello형 메인 업무 보드가 연결되었지만, 실제 사내 운영에서 쓰는 체크리스트/정렬/캘린더 세부 UX는 더 보강할 수 있다.
- Task Mesh는 backend/service 방향은 있으나 7개 view의 visual operator experience가 1급 UI가 아니다.
- Knowledge는 vault export/import preview와 graph report/evidence status 운영 흐름이 생겼다. 다만 실제 Obsidian local writer, 양방향 sync, conflict resolution은 아직 별도 phase가 필요하다.
- Jarvis와 quality mode는 있으나 staged change-management workflow, manager approval UX, runtime skill injection, reverse design, process mining은 별도 milestone이 필요하다.
- Enterprise rollout surface는 일부 schema/service에 있으나 SSO, portable template, binding mode, internal rollout hardening이 coherent operator flow로 묶이지 않았다.

## 증거

### 구현되었거나 실질적으로 존재함

| 개발기획서 영역 | 현재 증거 | 평가 |
|----------------|-----------|------|
| RT2-first identity and shell | `ui/src/App.tsx`, `ui/src/pages/rt2/*`, v2.0 planning archive | baseline 구현 |
| One-Liner text capture | `ui/src/pages/rt2/OneLinerPage.tsx`, `ui/src/lib/one-liner-draft.*`, `server/src/routes/rt2-tasks.ts` | 구현됨. 다만 page-bound였고 Phase 9에서 global surface로 확장됨 |
| Deliverable definition and base price | `packages/shared/src/validators/rt2-task.ts`, `server/src/__tests__/rt2-task-routes.test.ts` | baseline 구현 |
| Execution lifecycle | `server/src/services/rt2-task-execution.ts`, `packages/db/src/schema/rt2_v33_execution_attempts.ts` | baseline 구현 |
| CQRS event stream and projectors | `server/src/services/rt2-domain-events.ts`, `server/src/services/rt2-knowledge-projector.ts`, `packages/db/src/schema/rt2_v33_domain_events.ts` | baseline 구현 |
| Wiki and graph records | `server/src/routes/rt2-knowledge.ts`, `packages/db/src/schema/rt2_v33_wiki_pages.ts`, `packages/db/src/schema/rt2_v33_graph_projection.ts` | baseline 구현 |
| Jarvis advice, quality modes, hybrid search | `server/src/routes/rt2-jarvis.ts`, `server/src/routes/rt2-auto-evaluation.ts`, `server/src/routes/rt2-hybrid-search.ts` | baseline 구현 |
| P&L, marketplace, collaboration rewards | `server/src/routes/rt2-personal-pnl.ts`, `server/src/routes/rt2-agent-marketplace.ts`, `server/src/routes/rt2-collaboration-rewards.ts` | baseline 구현 |
| Governance and approvals | `server/src/routes/rt2-governance.ts`, `server/src/routes/approvals.ts`, `ui/src/pages/rt2/GovernancePage.tsx` | baseline 구현 |

### 개발기획서 대비 partial 또는 missing

| 개발기획서 영역 | Gap | v2.1 우선순위 |
|----------------|-----|--------------|
| One-Liner + voice + messenger | floating widget, global shortcut, voice draft, messenger inbound flow는 Phase 9에서 baseline 완료. Native mobile quick capture는 남음 | High |
| Immediate reward feedback | Phase 9에서 proposed reward evidence는 표시됨. 실제 ledger issuance는 quality/review settlement로 남음 | High |
| Daily report as core storage unit | API는 있으나 첫 화면/주요 workflow가 아직 3패널 daily cockpit이 아님 | High |
| OKR+KPI six-level hierarchy | 기존 goal/project/issue는 유용하지만 Mission → Objective → KR → Project → Task → To-Do 모델이 운영자 workflow로 충분히 드러나지 않음 | High |
| Task Mesh seven views | service/route는 있으나 dedicated seven-view visual UI가 없음 | High |
| Obsidian/wikiLLM integration | Obsidian vault sync, file-watch conflict handling, GRAPH_REPORT map, user-visible wiki lint workflow가 미완성 | High |
| Wiki Master daemon | projector는 있으나 1분 batch compiler/recovery daemon contract가 operator capability로 보이지 않음 | Medium |
| Jarvis runtime automation | execution attempt는 있으나 reverse design, process mining, runtime skill injection, MCP-facing automation은 partial | Medium |
| Change management | Shadow/Co-Pilot/Auto record는 있으나 manager trust-building UX와 policy rollout hardening 필요 | Medium |
| Enterprise rollout | enterprise schema/service는 있으나 SSO/template/binding mode가 coherent product flow가 아님 | Medium |
| Korean business UX | 일부 RT2 page가 English product label과 Korean helper text를 섞고 있음 | Medium |
| PDF exactness | 이 runtime에 PDF extraction tool이 없어 sibling markdown conversion으로 audit함 | Low |

## v2.1 마일스톤 권장안

**이름:** 개발기획서 반영 및 운영자 채택

**목표:** 구현된 RT2 baseline을 개발기획서에 더 가깝게 만들고, 빠른 캡처, 일일보고 cockpit, OKR/KPI traceability, task mesh, knowledge sync, Jarvis change management, enterprise rollout readiness를 운영자-ready workflow로 만든다.

**시작 Phase:** Phase 8. v2.0이 Phase 1-7을 완료했고 기존 phase directory가 evidence로 남아 있기 때문이다.

## 계획상 결론

- 기존 phase directory를 archive/move하지 않는 한 phase numbering을 reset하지 않는다.
- v2.1은 greenfield rebuild가 아니다. server/db/shared foundation은 이미 유용한 RT2 surface를 포함한다.
- 깊은 AI 고도화보다 user adoption gap을 먼저 닫는다. 개발기획서의 1차 약속은 friction-zero company work capture다.
- mechanical cleanup은 별도 GSD loop가 아니라 execution 중 inline으로 처리한다.
