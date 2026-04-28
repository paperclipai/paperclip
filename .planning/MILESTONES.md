# RealTycoon2 마일스톤

| Version | 이름 | 상태 | 시작 | 완료 | 메모 |
|---------|------|------|------|------|------|
| Legacy | Paperclip-based RT2 retrofit | Historical | 2026-04 | - | 이전 planning document는 넓은 완료를 주장했지만 repo는 여전히 partial RT2 implementation과 Paperclip-first product identity를 보였다 |
| v2.0 | RT2 Refoundation | Shipped | 2026-04-24 | 2026-04-25 | RT2를 primary product shell로 만들고 logging, execution, knowledge, Jarvis, quality, marketplace, collaboration, P&L을 live company-scoped record에 연결한 corrective milestone |
| v2.1 | 개발기획서 반영 및 운영자 채택 | Shipped | 2026-04-25 | 2026-04-25 | 업로드된 RealTycoon2 개발기획서 gap을 앱에서 보이게 만들고 capture, daily cockpit, OKR/KPI, task mesh, knowledge sync, Jarvis rollout, enterprise readiness를 완료 |
| v2.2 | 개발기획서 완전 정합성 고도화 | Shipped | 2026-04-25 | 2026-04-25 | 일일업무일지/Trello형 업무 보드/identity hardening/Knowledge Bridge/P&L/rollout evidence로 개발기획서 정합성을 약 94%까지 끌어올림 |
| v2.3 | 운영 검증 및 외부 연동 실체화 | Shipped | 2026-04-25 | 2026-04-27 | Phase 19-24 완료. 요구사항 17/17, integration 5/5, flows 5/5 충족. strict Nyquist validation debt는 tech debt로 이월 |
| v2.4 | Knowledge+Economy 심화 | Shipped | 2026-04-27 | 2026-04-28 | Phase 25-32 완료. 요구사항 24/24, phases 5/5, integration 5/5, flows 5/5 충족. 초기 audit gaps는 Phase 30-32 closure로 닫고 re-audit `passed` |
| v2.5 | Semantic Knowledge Intelligence | Shipped | 2026-04-28 | 2026-04-29 | Phase 33-38 완료. Semantic index, semantic search, contradiction review, Jarvis grounding, knowledge operations 요구사항 19/19 완료. 초기 audit gaps는 Phase 38 closure로 닫고 re-audit `passed` |

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

**상태:** 2026-04-27 완료  
**시작:** 2026-04-25  
**완료:** 2026-04-27  
**Phases:** 6 planned, 6 complete  
**Requirements:** 17 planned, 17 complete  
**Audit:** `tech_debt` (`.planning/milestones/v2.3-MILESTONE-AUDIT.md`)  
**Archives:**

- `.planning/milestones/v2.3-ROADMAP.md`
- `.planning/milestones/v2.3-REQUIREMENTS.md`
- `.planning/milestones/v2.3-MILESTONE-AUDIT.md`

### 목표

v2.2에서 기능적으로 완료했지만 `tech_debt`로 남긴 strict validation artifact와 외부 연동/운영 깊이 gap을 실제 운영자가 검수 가능한 제품 기능으로 닫는다.

### 계획된 Phase

| Phase | Name | Requirements | Status |
|-------|------|--------------|--------|
| 19 | Validation and Route Test Hardening | VALID-01, VALID-02, VALID-03 | Complete |
| 20 | Enterprise Rollout Connectors | ENT-02, ENT-03, ENT-04 | Complete |
| 21 | Obsidian Bidirectional Knowledge Sync | KNOW-02, KNOW-03, KNOW-04 | Complete |
| 22 | Settlement Governance and Anti-Gaming | ECON-02, ECON-03, ECON-04 | Complete |
| 23 | Advanced Work Board and Native Capture | TRELLO-03, TRELLO-04, TRELLO-05, CAPTURE-02, CAPTURE-03 | Complete |
| 24 | Phase 19 Verification Artifact Closure | VALID-01, VALID-02, VALID-03 | Complete |

### 완료한 것

- Phase 14-18 검증 산출물과 route fallback test evidence를 연결해 v2.2 검증 부채를 닫았다.
- SSO provider metadata validation, SCIM sync preview, rollout readiness audit log를 운영자 검수 흐름으로 만들었다.
- Obsidian-compatible vault writer dry-run, import apply, conflict resolution을 RT2-controlled knowledge store에 연결했다.
- Settlement comment/approve/reject flow를 gold ledger, P&L, audit log, anti-gaming signal과 연결했다.
- Trello advanced checklist/due/attachment/filter/sort와 mobile/native capture queue promotion/failure audit을 완성했다.
- Phase 19 `19-VERIFICATION.md` 누락 blocker를 Phase 24에서 닫았다.

### 알려진 Deferred Items

| Category | Item | Status |
|----------|------|--------|
| nyquist | Phase 19-24 strict `*-VALIDATION.md` | accepted tech debt |
| enterprise | live IdP login handshake and SCIM mutation apply | future hardening |
| knowledge | physical local vault writer daemon and continuous watcher | future hardening |
| economy | automatic penalty/reputation demotion | future governance hardening |
| native | app-store native distribution and external Slack/Teams install | future scope |
| uat_gap | Phase 01 / 01-UAT.md | unknown, 0 pending scenarios |
| uat_gap | Phase m1-6-daily-report / m1-6-UAT.md | unknown, 0 pending scenarios |

## v2.4 Knowledge+Economy 심화

**상태:** 2026-04-28 완료  
**시작:** 2026-04-27  
**완료:** 2026-04-28  
**Phases:** 8 planned/closure, 8 complete  
**Plans:** 10 complete  
**Requirements:** 24 planned, 24 complete  
**Audit:** initial `gaps_found`, final re-audit `passed` (`.planning/milestones/v2.4-MILESTONE-REAUDIT.md`)  
**Archives:**

- `.planning/milestones/v2.4-ROADMAP.md`
- `.planning/milestones/v2.4-REQUIREMENTS.md`
- `.planning/milestones/v2.4-MILESTONE-AUDIT.md`
- `.planning/milestones/v2.4-MILESTONE-REAUDIT.md`

### 목표

daily wiki projector, graphify projector, coin ledger atomicity, settlement governance hardening, consistency linting으로 knowledge projection과 economy governance의 심화 기능을 구현한다.

### 완료한 Phase

| Phase | Name | Requirements | Status |
|-------|------|--------------|--------|
| 25 | Daily Wiki Projector | WIKI-01, WIKI-02, WIKI-03, WIKI-04, WIKI-05 | Complete |
| 26 | Graphify Projector | GRAPH-01, GRAPH-02, GRAPH-03, GRAPH-04, GRAPH-05, GRAPH-06 | Complete |
| 27 | Coin Ledger Atomicity | LEDGER-01, LEDGER-02, LEDGER-03, LEDGER-04, LEDGER-05 | Complete |
| 28 | Settlement Governance Hardening | SETTLE-01, SETTLE-02, SETTLE-03, SETTLE-04 | Complete |
| 29 | Consistency Linting (Batch) | LINT-01, LINT-02, LINT-03, LINT-04 | Complete |
| 30 | Knowledge Artifact and Verification Closure | WIKI, GRAPH | Complete |
| 31 | Economy Artifact and Verification Closure | LEDGER, SETTLE | Complete |
| 32 | Lint Traceability and Milestone Acceptance Closure | LINT | Complete |

### 완료한 것

- Board/domain event를 daily wiki page, date index, chronological log, per-user page로 project하는 Daily Wiki Projector를 완료했다.
- Daily wiki output을 graph node/edge로 연결하고 confidence tag, incremental refresh, graph report, community evidence를 보강했다.
- Coin ledger에 atomic `balanceAfter`, debit/credit `leg`, transaction rollback, reconciliation, non-negative balance protection을 추가했다.
- Settlement governance에 duplicate materialization guard, linked ledger evidence, anti-gaming signal, company threshold settings를 추가했다.
- Scheduled, evidence-only wiki consistency linting과 `embedding_consistency` issue type을 추가했다.
- Initial milestone audit의 orphaned/partial requirement gaps를 Phase 30-32에서 summary, verification, validation, frontmatter repair로 닫았다.

### 감사 결과

초기 audit은 `gaps_found`였다. 요구사항 구현 증거는 있었지만 milestone gate가 요구하는 `SUMMARY.md`, `VERIFICATION.md`, `VALIDATION.md`, `requirements-completed` frontmatter가 부족했다.

Phase 30-32 closure 후 re-audit 결과:

| Gate | Score |
|------|-------|
| Requirements | 24/24 |
| Phases | 5/5 |
| Integration | 5/5 |
| Flows | 5/5 |

### 검증

- `pnpm --filter @paperclipai/server test -- rt2-wiki-lint` passed
- `pnpm --filter @paperclipai/server typecheck` passed
- `pnpm typecheck` passed
- `pnpm test` passed; 265 files passed, 23 skipped; 1460 tests passed, 121 skipped
- `pnpm test:e2e`는 기본 milestone close gate가 아니므로 실행하지 않았다.

### 의존성

- Phase 26 (Graphify) depends on Phase 25 (Daily Wiki reads wiki output)
- Phase 28 (Settlement) depends on Phase 27 (Ledger integrity)
- Phase 29 (Linting) depends on Phase 26 (stable wiki content)

### 알려진 Deferred Items

| Category | Item | Reason |
|----------|------|--------|
| vector | vector embedding + semantic search | deferred until pgvector ready |
| federation | cross-company knowledge federation | outside trusted ecosystem |
| lint | live provider-backed contradiction detection | deterministic local analyzer and injectable tests accepted for v2.4 |
| postgres | embedded Postgres tests in default Windows run | selected embedded cases remain opt-in |

## v2.5 Semantic Knowledge Intelligence

**상태:** 2026-04-29 완료
**시작:** 2026-04-28  
**완료:** 2026-04-29
**Phases:** 6 planned/closure, 6 complete
**Plans:** 6 complete
**Requirements:** 19 planned, 19 complete
**Audit:** initial `gaps_found`, final re-audit `passed` (`.planning/milestones/v2.5-MILESTONE-REAUDIT.md`)
**Artifacts:**

- `.planning/milestones/v2.5-ROADMAP.md`
- `.planning/milestones/v2.5-REQUIREMENTS.md`
- `.planning/milestones/v2.5-MILESTONE-AUDIT.md`
- `.planning/milestones/v2.5-MILESTONE-REAUDIT.md`

### 목표

Daily wiki/graph knowledge를 embedding-backed semantic retrieval, contradiction review, Jarvis answer grounding, operator-facing knowledge health로 고도화한다.

### 완료한 Phase

| Phase | Name | Requirements | Status |
|-------|------|--------------|--------|
| 33 | Semantic Index Foundation | SEM-01, SEM-02, SEM-03, SEM-04 | Complete |
| 34 | Semantic Knowledge Search | SEARCH-01, SEARCH-02, SEARCH-03, SEARCH-04 | Complete |
| 35 | Contradiction Review Workflow | CONTRA-01, CONTRA-02, CONTRA-03, CONTRA-04 | Complete |
| 36 | Jarvis Grounded Answers | JARVIS-01, JARVIS-02, JARVIS-03, JARVIS-04 | Complete |
| 37 | Knowledge Intelligence Operations | OPS-01, OPS-02, OPS-03 | Complete |
| 38 | Semantic Knowledge Artifact Closure | JARVIS-01, JARVIS-02, JARVIS-03, JARVIS-04 | Complete |

### 완료한 것

- pgvector-ready semantic index storage, deterministic fallback embedding, incremental reindex status/action을 추가했다.
- Daily wiki, graph evidence, work board artifact, deliverable source를 semantic + lexical fallback search surface로 통합했다.
- Contradiction candidate generation, resolution decision, activity-log audit, semantic freshness integration을 추가했다.
- Jarvis answer에 cited evidence, stale evidence warning, unresolved contradiction warning, citation targets를 연결했다.
- Knowledge operations dashboard와 batch health gate가 semantic index, contradiction review, Jarvis grounding traceability loss를 잡도록 만들었다.
- Phase 38에서 missing verification, validation, summary frontmatter, requirements checkbox/traceability gap을 닫았다.

### 감사 결과

초기 audit은 `gaps_found`였다. 요구사항 구현 증거는 있었지만 Phase 34-36 `VERIFICATION.md`, Phase 36 summary frontmatter, Phase 33-37 `VALIDATION.md`, requirement checkbox가 부족했다.

Phase 38 closure 후 re-audit 결과:

| Gate | Score |
|------|-------|
| Requirements | 19/19 |
| Phases | 6/6 |
| Integration | 5/5 |
| Flows | 5/5 |

### 검증

- `pnpm typecheck` passed
- `pnpm test` passed
- Targeted semantic index/search/wiki lint/Jarvis/knowledge operations suites passed
- Embedded Postgres route tests remain opt-in on Windows and documented per phase

### 알려진 Deferred Items

| Category | Item | Reason |
|----------|------|--------|
| federation | cross-company knowledge federation | trusted company ecosystem 밖 |
| autonomy | automatic wiki rewrites without approval | contradiction review loop가 먼저 안정화되어야 함 |
| provider | mandatory live provider dependency | deterministic fallback이 local/CI 기본이어야 함 |
| mobile | native mobile semantic search UX | web operator loop가 먼저 검증되어야 함 |

---
*마지막 업데이트: 2026-04-29, v2.5 milestone archived*
