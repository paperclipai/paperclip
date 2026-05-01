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
| v2.6 | 운영 커넥터 및 자율성 하드닝 | Shipped | 2026-04-29 | 2026-04-29 | Phase 39-43 완료. 요구사항 12/12, integration 5/5, flows 5/5 충족. Full-suite timeout과 Windows embedded Postgres skip은 tech debt로 수용 |
| v2.7 | 릴리즈 호스트 검증 및 런타임 신뢰도 | Shipped | 2026-04-29 | 2026-04-30 | Phase 44-47 완료. 요구사항 11/11, integration 4/4, flows 4/4 충족. Runtime confidence blocker 0, Windows default embedded Postgres skip은 accepted debt로 수용 |
| v2.8 | RealTycoon2 Product Identity and Daily Work UX | Shipped | 2026-04-30 | 2026-04-30 | Phase 48-53 완료. 요구사항 15/15, integration 5/5, flows 5/5 충족. Korean-first daily work board, One-Liner board review, supporting evidence, identity gate 완료 |
| v2.9 | Native Capture and Draft Reliability | Shipped | 2026-04-30 | 2026-04-30 | Phase 54-58 완료. 요구사항 13/13 완료. Persistent draft revision, PWA/mobile quick capture, signed messaging inbound, review reliability, distribution boundary closure 완료 |
| v3.0 | Native Distribution Readiness | Shipped | 2026-04-30 | 2026-05-01 | Phase 59-64 complete. Requirements 12/12, audit `tech_debt`; signing/updater/resident surface/push/final distribution evidence gates 완료 |
| v3.1 | DevPlan Core Convergence | Active | 2026-05-01 | - | Phase 65-66 complete, Phase 67-71 planned. 개발기획서 대비 약 64% 정적 싱크로율을 기준선으로 alignment truth, identity cleanup, daily cockpit을 닫았고 Multica runtime, wikiLLM, Graphify v3, economy loop, acceptance gate를 이어서 닫는다 |

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

## v2.6 운영 커넥터 및 자율성 하드닝

**상태:** 2026-04-29 완료  
**시작:** 2026-04-29  
**완료:** 2026-04-29  
**Phases:** 5 planned, 5 complete  
**Plans:** 6 complete  
**Requirements:** 12 planned, 12 complete  
**Audit:** `tech_debt` (`.planning/milestones/v2.6-MILESTONE-AUDIT.md`)  
**Artifacts:**

- `.planning/milestones/v2.6-ROADMAP.md`
- `.planning/milestones/v2.6-REQUIREMENTS.md`
- `.planning/milestones/v2.6-MILESTONE-AUDIT.md`

### 목표

v2.5에서 닫은 semantic knowledge loop를 실제 외부 운영 경계, mobile/native capture, Jarvis autonomy guardrail, validation gate까지 확장해 운영 가능한 hardening layer로 만든다.

### 완료한 Phase

| Phase | Name | Requirements | Status |
|-------|------|--------------|--------|
| 39 | Enterprise Connector Apply Loop | EXT-01, EXT-02 | Complete |
| 40 | Trusted Local Knowledge Bridge | EXT-03 | Complete |
| 41 | Native and Mobile Capture Hardening | CAP-01, CAP-02, CAP-03 | Complete |
| 42 | Jarvis Autonomy Eval Guardrails | AUTO-01, AUTO-02, AUTO-03 | Complete |
| 43 | Validation Debt and Milestone Gate Closure | VAL-01, VAL-02, VAL-03 | Complete |

### 범위

- IdP handshake와 SCIM apply mutation을 audit 가능한 enterprise connector flow로 고도화한다.
- Obsidian/local bridge를 trusted daemon pairing과 sync health 중심으로 운영 가능하게 만든다.
- Slack/Teams/native/mobile capture source를 signed source, review queue, semantic context, mobile search UX까지 연결한다.
- Jarvis knowledge rewrite는 direct apply 없이 eval-backed proposal과 approval route로 제한한다.
- Phase 19-24 strict validation debt와 legacy UAT unknown 항목을 정리하고 milestone artifact gate를 강화한다.

### 완료한 것

- Enterprise rollout connector가 SSO callback-state evidence, structured failure reason, SCIM preview/apply result, partial failure, rollback candidate를 audit 가능한 evidence로 남긴다.
- Trusted local bridge pairing, heartbeat, sync queue, conflict count, blocked reason, last applied state가 API/UI에 노출된다.
- Capture source installation/signing evidence와 inbound draft semantic context, duplicate warning, source evidence, promotion audit metadata가 연결된다.
- Jarvis rewrite는 direct apply 없이 proposal, eval rubric, risk, approval route, monitoring evidence로만 운영된다.
- Phase 19-24 validation debt와 legacy UAT unknown closure를 문서화하고 `rt2:milestone-gate`로 artifact 누락을 탐지한다.

### 감사 결과

| Gate | Score |
|------|-------|
| Requirements | 12/12 |
| Phases | 5/5 |
| Integration | 5/5 |
| Flows | 5/5 |

Audit status는 `tech_debt`다. Critical blocker는 없지만 다음 항목을 수용하고 close했다.

### 알려진 Deferred Items

| Category | Item | Status |
|----------|------|--------|
| test | Phase 40-43 full `pnpm test` | timeout on Windows host, targeted checks passed |
| postgres | Embedded Postgres route/persistence suites | skipped by default on Windows host |
| validation_metadata | Phase 39 `VALIDATION.md` frontmatter | stale draft/wave_0 metadata, execution evidence passed |
| uat_gap | Phase 01 / 01-UAT.md | acknowledged at close, unknown, 0 pending scenarios |
| uat_gap | Phase 43 / 43-LEGACY-UAT-CLOSURE.md | acknowledged at close, tool reports unknown, closure artifact says closed |
| uat_gap | Phase m1-6-daily-report / m1-6-UAT.md | acknowledged at close, unknown, 0 pending scenarios |

## v2.7 릴리즈 호스트 검증 및 런타임 신뢰도

**상태:** 2026-04-30 완료  
**시작:** 2026-04-29  
**완료:** 2026-04-30  
**Phases:** 4 planned, 4 complete  
**Plans:** 4 complete  
**Requirements:** 11 planned, 11 complete  
**Audit:** `tech_debt` (`.planning/milestones/v2.7-MILESTONE-AUDIT.md`)  
**Artifacts:**

- `.planning/milestones/v2.7-ROADMAP.md`
- `.planning/milestones/v2.7-REQUIREMENTS.md`
- `.planning/milestones/v2.7-MILESTONE-AUDIT.md`

### 목표

v2.6에서 tech debt로 수용한 full-suite timeout, Windows embedded Postgres skip, stale validation metadata, legacy UAT closure inconsistency를 release-host 재현성, embedded Postgres runtime coverage, artifact/UAT truth alignment, operator-facing confidence evidence로 닫는다.

### 계획된 Phase

| Phase | Name | Requirements | Status |
|-------|------|--------------|--------|
| 44 | Release Host Verification Harness | REL-01, REL-02, REL-03 | Complete |
| 45 | Embedded Postgres Runtime Coverage | PG-01, PG-02, PG-03 | Complete |
| 46 | Artifact and UAT Truth Alignment | ART-01, ART-02, ART-03 | Complete |
| 47 | Runtime Confidence Operations Surface | CONF-01, CONF-02 | Complete |

### 범위

- Release-host full-suite verification을 timeout/failure owner와 retry evidence가 있는 gate로 만든다.
- Embedded Postgres persistence/route suites가 Windows host에서 skip으로 묻히지 않게 한다.
- Validation frontmatter, legacy UAT closure, milestone gate truth를 일관되게 만든다.
- 운영자가 release confidence, accepted tech debt, blocker/deferred status를 한 곳에서 확인하게 한다.

### 완료한 것

- Phase 44에서 release-host verification harness를 추가했다.
- `pnpm typecheck`와 stable Vitest slice 실행을 `summary.json`, `report.md`, per-slice log evidence로 남긴다.
- failed/timed-out/error slice rerun은 기존 audit trail에 attempt를 append한다.
- `REL-01`, `REL-02`, `REL-03`은 Phase 44에서 완료됐다.
- Phase 45에서 Windows embedded Postgres default skip을 `accepted_debt`로 분류하고 host-ready closure command를 제공했다.
- Phase 46에서 validation frontmatter, legacy UAT closure, requirement traceability를 milestone artifact gate truth와 정렬했다.
- Phase 47에서 `rt2:runtime-confidence` generated report로 blockers, accepted debt, deferred scope, latest verification evidence를 통합했다.

### 감사 결과

| Gate | Score |
|------|-------|
| Requirements | 11/11 |
| Phases | 4/4 |
| Integration | 4/4 |
| Flows | 4/4 |

Audit status는 `tech_debt`다. Critical blocker는 없지만 다음 항목을 수용하고 close했다.

### 알려진 Deferred Items

| Category | Item | Status |
|----------|------|--------|
| postgres | Windows default embedded Postgres broader suite execution | accepted debt; closure command is `pnpm rt2:embedded-postgres-host-ready` |
| runtime_confidence | Latest runtime confidence report | `accepted_debt` because release-host summary intentionally records embedded-postgres Windows default skip |
| test | Full `pnpm test` on this host | timeout during Phase 47 and milestone close verification; focused tests, milestone gate, typecheck, and runtime confidence report passed |
| future_scope | Native/mobile distribution, cross-company federation, provider-backed eval mandate, new Jarvis autonomous apply behavior | deferred future scope |

## v2.8 RealTycoon2 Product Identity and Daily Work UX

**상태:** 2026-04-30 완료  
**시작:** 2026-04-30  
**완료:** 2026-04-30  
**Phases:** 6 planned, 6 complete  
**Plans:** 14 complete  
**Requirements:** 15 planned, 15 complete  
**Audit:** `passed` (`.planning/milestones/v2.8-MILESTONE-AUDIT.md`)  
**Artifacts:**

- `.planning/milestones/v2.8-ROADMAP.md`
- `.planning/milestones/v2.8-REQUIREMENTS.md`
- `.planning/milestones/v2.8-MILESTONE-AUDIT.md`

### 목표

앱을 구동했을 때 RealTycoon2가 Paperclip-derived 도구가 아니라 한국어 일일 업무 운영 시스템으로 즉시 인식되도록 제품 정체성과 핵심 보드 UX를 완성한다.

### 완료한 Phase

| Phase | Name | Requirements | Status |
|-------|------|--------------|--------|
| 48 | RT2 Identity and Korean Shell | IDENT-01..04 | Complete |
| 49 | Daily Work Kanban Core | BOARD-01..03 | Complete |
| 50 | Work Card Editing and Board Controls | BOARD-04..05 | Complete |
| 51 | One-Liner to Board Capture Flow | CAPTURE-01..03 | Complete |
| 52 | Supporting Surfaces and Identity Regression Gate | SUPPORT-01..03 | Complete |
| 53 | v2.8 Verification and Traceability Closure | BOARD/CAPTURE/SUPPORT closure | Complete |

### 완료한 것

- Product-facing shell, navigation, fallback/loading, settings, browser title이 RealTycoon2-first Korean identity를 사용한다.
- `daily-work`가 첫 운영 화면이 되었고, 일일 업무 보드는 `할 일 / 진행 중 / 완료` 3단 lane과 즉시 저장 흐름을 제공한다.
- 업무 카드는 Task/To-Do/Deliverable 구분, 담당자, 마감, OKR/KPI, 가격/gold, 품질 상태를 board context에서 보여주고 quick edit를 지원한다.
- One-Liner 입력은 board review inbox로 연결되며 source evidence, duplicate warning, promotion/failure flow를 갖는다.
- Jarvis/wiki/graph/economy는 핵심 보드 옆 `보조 근거`와 카드별 support evidence로 재배치됐다.
- `rt2:identity-gate`와 `test:identity-gate`가 product-facing legacy naming과 영문 default regression을 탐지한다.
- Phase 53이 verification/validation artifact gaps와 ROADMAP/REQUIREMENTS traceability drift를 닫았다.

### 감사 결과

| Gate | Score |
|------|-------|
| Requirements | 15/15 |
| Phases | 6/6 |
| Integration | 5/5 |
| Flows | 5/5 |

Audit status는 `passed`다. 남은 항목은 blocker가 아니라 accepted debt 또는 future scope다.

### 알려진 Deferred Items

| Category | Item | Status |
|----------|------|--------|
| test | Full `pnpm test` on this Windows host | failed in `server/src/__tests__/workspace-runtime.test.ts` provision-command case after 113 files / 721 tests passed; focused Vitest, identity gate, and typecheck passed |
| postgres | Embedded Postgres route suites | skipped by default on Windows unless explicitly enabled |
| capture | Persistent draft revision route | deferred future enhancement |
| identity | Full internal package rebrand away from `@paperclipai/*` | out of scope for product-facing v2.8 |
| future_scope | Federation full apply, app-store native distribution, autonomous Jarvis apply without approval, provider-only eval mandate | deferred future scope |

## v2.9 Native Capture and Draft Reliability

**상태:** 2026-04-30 완료
**시작:** 2026-04-30
**완료:** 2026-04-30
**Phases:** 5 planned, 5 complete
**Plans:** 5 complete
**Requirements:** 13 planned, 13 complete

### 목표

One-Liner와 board review flow를 저장 가능한 draft revision 기반으로 안정화하고, native/mobile/messaging quick capture entry가 같은 검수 루프로 들어오게 만든다.

### 완료한 Phase

| Phase | Name | Requirements | Status |
|-------|------|--------------|--------|
| 54 | Persistent Capture Draft Revision | DRAFT-01..04 | Complete |
| 55 | Native and Mobile Quick Capture Entry | NATIVE-01..03 | Complete |
| 56 | Messaging Capture Source Installation | MSG-01..03 | Complete |
| 57 | Capture Review Operations and Reliability | REVIEW-01..03 | Complete |
| 58 | v2.9 Verification and Distribution Readiness Closure | DRAFT/NATIVE/MSG/REVIEW closure | Complete |

### 완료한 것

- Persistent capture draft revision, latest revision promotion, Korean board review edit/state actions를 구현했다.
- PWA/mobile quick capture route, bounded local queue, mobile source handoff, RealTycoon2 manifest identity를 구현했다.
- Slack/Teams/webhook source setup, signed public inbound route, redacted source metadata, malformed/source failure evidence를 구현했다.
- Board review inbox source/status/evidence filters, promoted draft evidence labels, source-level capture reliability report를 구현했다.
- Phase 58이 validation/verification artifact drift, `.planning/REQUIREMENTS.md`/`.planning/ROADMAP.md` traceability, future distribution boundary를 닫았다.

### 알려진 Deferred Items

| Category | Item | Status |
|----------|------|--------|
| distribution | App-store signing/updater/notarization/release channel | v3.0 scope |
| resident | OS-level global shortcut and resident tray app | v3.0 scope |
| push | Mobile push notification | v3.0 scope |
| federation | Cross-company federation full apply | future scope |
| autonomy | Autonomous Jarvis apply without approval | future scope |

## v3.0 Native Distribution Readiness

**상태:** Shipped
**시작:** 2026-04-30
**완료:** 2026-05-01
**Phases:** 6 complete
**Requirements:** 12 complete
**Audit:** `tech_debt` (`.planning/milestones/v3.0-MILESTONE-AUDIT.md`)
**Artifacts:**

- `.planning/milestones/v3.0-ROADMAP.md`
- `.planning/milestones/v3.0-REQUIREMENTS.md`
- `.planning/milestones/v3.0-MILESTONE-AUDIT.md`

### 목표

RealTycoon2를 signed native distribution, release channel, updater, resident desktop entry, mobile push까지 운영 가능한 배포 표면으로 끌어올린다. v2.9 DRAFT/NATIVE/MSG/REVIEW capture reliability는 shipped baseline으로 고정하고 regression gate로만 보호한다.

### 완료한 Phase

| Phase | Name | Requirements | Status |
|-------|------|--------------|--------|
| 59 | Native Distribution Foundation | DIST-01 | Complete |
| 60 | Signing and Notarization Pipeline | DIST-02, DIST-03 | Complete |
| 61 | Release Channels and Signed Updater | DIST-04, DIST-05 | Complete |
| 62 | Resident Tray and Global Shortcut | RES-01, RES-02, RES-03 | Complete |
| 63 | Mobile Push Notification Loop | PUSH-01, PUSH-02, PUSH-03 | Complete |
| 64 | v3.0 Distribution Gate and Capture Regression Closure | DIST-06 | Complete |

### 범위

- Native shell packaging 후보, signing credential inventory, platform capability boundary를 확정한다.
- macOS Developer ID signing, hardened runtime, notarization, ticket stapling/Gatekeeper verification을 release gate에 넣는다.
- Windows MSIX/installer signing, timestamping, Store re-signing 또는 trusted signing path를 release gate에 넣는다.
- Internal/beta/stable release channel, signed updater feed, rollback candidate, rollout evidence를 관리한다.
- Resident tray/menubar app과 OS-level global shortcut이 v2.9 draft review loop로 빠른 입력을 전달하게 한다.
- Mobile/Web Push/APNs token, delivery/retry/failure/click evidence를 company-scoped notification loop로 연결한다.

### 완료한 것

- Phase 59에서 Tauri v2 native shell baseline, future `apps/desktop` package layout, signing/updater/channel inventory, v2.9 regression boundary를 확정했다.
- Phase 60에서 macOS/Windows native signing evidence gate를 추가했다.
- Phase 61에서 internal/beta/stable release channel and signed updater evidence gate를 추가했다.
- Phase 62에서 resident tray/menubar status, global shortcut lifecycle/privacy, native capture review handoff를 검증하는 resident surface evidence gate를 추가했다.
- Phase 63에서 Mobile/Web Push/APNs registration scope, minimal payload target, delivery/retry/invalid-token handling, notification click-through, capture reliability metric을 검증하는 push notification evidence gate를 추가했다.
- Phase 64에서 Phase 60-63 summary evidence와 focused v2.9 regression evidence를 묶는 final distribution gate를 추가하고 v3.0 completion truth를 닫았다.

### 감사 결과

v3.0 audit status는 `tech_debt`다. 요구사항 12/12, phases 6/6, integration 5/5, flows 5/5가 충족됐고 blocker는 없다. 남은 debt는 일부 `VALIDATION.md` task row가 `pending`으로 남아 있는 artifact hygiene drift와 Windows/default host suite caveat다.

## v3.1 DevPlan Core Convergence

**상태:** Active
**시작:** 2026-05-01
**완료:** -
**Phases:** 2 complete, 5 planned
**Requirements:** 9 complete, 15 planned
**Baseline:** RealTycoon2 개발기획서 대비 정적 싱크로율 약 64%

### 목표

RealTycoon2 개발기획서의 핵심 제품 루프와 Multica/wikiLLM/Graphify 엔진 기준을 실제 코드, UI, 문서, 검증 증거로 다시 정렬한다.

### 계획된 Phase

| Phase | Name | Requirements | Status |
|-------|------|--------------|--------|
| 65 | DevPlan Truth and Identity Cleanup | ALIGN-01..03, IDENTITY-01..03 | Complete |
| 66 | Daily Work and OKR Cockpit Convergence | DAILY-01..03 | Complete |
| 67 | Multica Runtime Execution Alignment | RUNTIME-01..03 | Planned |
| 68 | wikiLLM Living Memory Workflow | WIKI-01..03 | Planned |
| 69 | Graphify v3 Corpus Graph Sidecar | GRAPH-01..04 | Planned |
| 70 | Economy, Marketplace, P&L, and CareerMate Loop | ECON-01..03 | Planned |
| 71 | v3.1 DevPlan Acceptance Gate | GATE-01..02 | Planned |

### 범위

- 개발기획서 alignment matrix를 장/핵심 축별 code/UI/test/evidence와 연결한다.
- product-facing Paperclip/Paper Company residue를 제거하고 legacy 명칭은 compatibility/reference로 제한한다.
- Daily Work를 3패널 cockpit, OKR tree, One-Liner review, Jarvis/detail 흐름으로 수렴시켰다.
- Multica runtime queue/claim/heartbeat/cancellation/progress evidence를 RT2 execution lifecycle에 반영한다.
- wikiLLM `index.md`/`log.md`/topic/schema page workflow를 export/update/citation loop로 만든다.
- Graphify v3 corpus graph sidecar를 source cache, provenance, clustering, path/query API, graph report 기준으로 구현한다.
- Marketplace, P&L, amoeba economy, CareerMate progression을 deliverable/quality/ledger evidence에 연결한다.

### 알려진 Deferred Items

| Category | Item | Status |
|----------|------|--------|
| federation | Cross-company federation full apply | v3.1 범위 밖 |
| autonomy | Autonomous Jarvis direct apply without approval | approval-first 원칙 유지 |
| marketplace | Public/open company marketplace launch | public rollout 단계로 defer |
| store_ops | Public store listing/marketing/reviewer operations | v3.0 operator evidence 실제 수집 이후 |
| native_credentials | Apple/Windows signing credential, APNs/Web Push secret | repo에 저장하지 않음 |
| capture | v2.9 capture reliability rewrite | regression fix만 허용 |

---
*마지막 업데이트: 2026-05-01, Phase 66 completed*
