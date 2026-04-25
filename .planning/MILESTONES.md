# RealTycoon2 마일스톤

| Version | 이름 | 상태 | 시작 | 완료 | 메모 |
|---------|------|------|------|------|------|
| Legacy | Paperclip-based RT2 retrofit | Historical | 2026-04 | - | 이전 planning document는 넓은 완료를 주장했지만 repo는 여전히 partial RT2 implementation과 Paperclip-first product identity를 보였다 |
| v2.0 | RT2 Refoundation | Shipped | 2026-04-24 | 2026-04-25 | RT2를 primary product shell로 만들고 logging, execution, knowledge, Jarvis, quality, marketplace, collaboration, P&L을 live company-scoped record에 연결한 corrective milestone |
| v2.1 | 개발기획서 반영 및 운영자 채택 | Shipped | 2026-04-25 | 2026-04-25 | 업로드된 RealTycoon2 개발기획서 gap을 앱에서 보이게 만들고 capture, daily cockpit, OKR/KPI, task mesh, knowledge sync, Jarvis rollout, enterprise readiness를 완료 |
| v2.2 | 개발기획서 완전 정합성 고도화 | Shipped | 2026-04-25 | 2026-04-25 | 일일업무일지/Trello형 업무 보드/identity hardening/Knowledge Bridge/P&L/rollout evidence로 개발기획서 정합성을 약 94%까지 끌어올림 |
| v2.3 | 운영 검증 및 외부 연동 실체화 | Active | 2026-04-25 | - | Phase 19 완료. 남은 SSO/SCIM, Obsidian sync, settlement governance, advanced board/capture 진행 중 |

## v2.0 RT2 Refoundation

**상태:** 2026-04-25 완료  
**Phases:** 7  
**Plans:** 13  
**Requirements:** v1 requirements 20/20 완료  
**Archives:**

- `.planning/milestones/v2.0-ROADMAP.md`
- `.planning/milestones/v2.0-REQUIREMENTS.md`

### 완료한 것

- RT2-first company shell과 navigation.
- base-price 구조를 가진 deliverable-aware One-Liner capture.
- RT2 task/todo work를 위한 execution lifecycle persistence.
- append-only domain event stream과 projector state.
- cumulative wiki page와 provenance-aware graph projection.
- evidence-backed Jarvis, quality mode, hybrid search.
- ledger-backed P&L, live marketplace evidence, derived collaboration reward.

### 알려진 Deferred Items

close-audit artifact 2개는 인정하고 defer했다:

| Category | Item | Status |
|----------|------|--------|
| UAT gap | Phase 01 / 01-UAT.md | unknown, 0 pending scenarios |
| UAT gap | Phase m1-6-daily-report / m1-6-UAT.md | unknown, 0 pending scenarios |

## v2.1 개발기획서 반영 및 운영자 채택

**상태:** 2026-04-25 완료  
**시작:** 2026-04-25  
**완료:** 2026-04-25  
**Phases:** 6  
**Plans:** 6  
**Requirements:** 24/24 완료  
**주요 audit artifact:** `.planning/DEVPLAN-ALIGNMENT.md`
**Archives:**

- `.planning/milestones/v2.1-ROADMAP.md`
- `.planning/milestones/v2.1-REQUIREMENTS.md`

### 완료한 것

- 개발기획서 alignment checklist와 gap visibility.
- friction-zero One-Liner capture surface.
- daily report cockpit과 OKR/KPI traceability.
- Task Mesh와 wiki/graph/Obsidian-ready knowledge workflow.
- Jarvis Shadow/Co-Pilot/Auto change-management hardening.
- enterprise rollout setting, portable template, binding mode, RT2 terminology cleanup.

### 알려진 Deferred Items

close-audit artifact 2개는 v2.0에 이어 v2.1 close에서도 인정하고 defer했다. pending scenario는 0개다.

| Category | Item | Status |
|----------|------|--------|
| UAT gap | Phase 01 / 01-UAT.md | unknown, 0 pending scenarios |
| UAT gap | Phase m1-6-daily-report / m1-6-UAT.md | unknown, 0 pending scenarios |

## v2.2 개발기획서 완전 정합성 고도화

**상태:** 2026-04-25 완료  
**시작:** 2026-04-25  
**완료:** 2026-04-25  
**Phases:** 5  
**Plans:** 5  
**Requirements:** 11/11 완료  
**Audit:** `tech_debt` (`.planning/milestones/v2.2-MILESTONE-AUDIT.md`)  
**개발기획서 정합성:** 약 94%  
**Archives:**

- `.planning/milestones/v2.2-ROADMAP.md`
- `.planning/milestones/v2.2-REQUIREMENTS.md`
- `.planning/milestones/v2.2-MILESTONE-AUDIT.md`

### 완료한 것

- 일일업무일지 3칸 칸반의 Trello형 drag/drop 이동과 즉시 저장.
- product-facing Paperclip/Multica 노출 축소와 RealTycoon2/Jarvis/작업 중심 identity hardening.
- Trello 기반 RealTycoon2 업무 보드, Task/To-Do 카드, 산출물/가격/OKR badge, 빠른 편집.
- Slack/Teams/Webhook/Mobile/Native One-Liner inbound draft contract와 검수 route.
- Knowledge Bridge의 projector, vault export, import preview, graph report, evidence status 운영 흐름.
- P&L/marketplace/enterprise rollout의 가격/품질/기준가/gold/협업 보상/SSO/template/binding/policy evidence.

### 알려진 Deferred Items

기능 완료와 통합 흐름은 통과했지만 다음 항목은 tech debt로 인정하고 defer했다.

| Category | Item | Status |
|----------|------|--------|
| validation_gap | Phase 14-18 `VALIDATION.md` | missing |
| route_test | Phase 17-18 scoped server route suites | embedded Postgres host init 제약으로 skip |
| uat_gap | Phase 01 / 01-UAT.md | unknown, 0 pending scenarios |
| uat_gap | Phase m1-6-daily-report / m1-6-UAT.md | unknown, 0 pending scenarios |

## v2.3 운영 검증 및 외부 연동 실체화

**상태:** 2026-04-25 시작  
**시작:** 2026-04-25  
**Phases:** 5 planned  
**Requirements:** 17 planned  
**현재 문서:**

- `.planning/ROADMAP.md`
- `.planning/REQUIREMENTS.md`

### 목표

v2.2에서 기능적으로 완료했지만 `tech_debt`로 남긴 strict validation artifact와 외부 연동/운영 깊이 gap을 실제 운영자가 검수 가능한 제품 기능으로 닫는다.

### 계획된 Phase

| Phase | Name | Requirements | Status |
|-------|------|--------------|--------|
| 19 | Validation and Route Test Hardening | VALID-01, VALID-02, VALID-03 | Complete |
| 20 | Enterprise Rollout Connectors | ENT-02, ENT-03, ENT-04 | Pending |
| 21 | Obsidian Bidirectional Knowledge Sync | KNOW-02, KNOW-03, KNOW-04 | Pending |
| 22 | Settlement Governance and Anti-Gaming | ECON-02, ECON-03, ECON-04 | Pending |
| 23 | Advanced Work Board and Native Capture | TRELLO-03, TRELLO-04, TRELLO-05, CAPTURE-02, CAPTURE-03 | Pending |

---
*마지막 업데이트: 2026-04-25, Phase 19 완료*
