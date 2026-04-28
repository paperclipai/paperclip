# RealTycoon2

## 이 프로젝트가 무엇인가

RealTycoon2는 iSens Corp. 내부에서 사람과 AI 팀이 함께 쓰는 회사 운영 시스템이다. RT2 work logging, deliverable management, execution lifecycle state, cumulative wiki/graph knowledge, Jarvis assistance, quality evaluation, governance, amoeba-style economic feedback을 하나의 company-scoped operating loop로 묶는다.

Paperclip-derived control-plane 자산은 제품 정체성이 아니라 infrastructure와 reference material로 취급한다. RealTycoon2의 business truth는 RT2-controlled schema, service, API, projection, UI surface에 있어야 한다.

## 핵심 가치

회사 범위 work signal은 disconnected tool이나 Paperclip-shaped manual workflow를 강요하지 않고 logging -> execution -> knowledge accumulation -> approval -> economic feedback으로 이어져야 한다.

## 현재 상태

**완료된 마일스톤:** v2.0 RT2 Refoundation, v2.1 개발기획서 반영 및 운영자 채택, v2.2 개발기획서 완전 정합성 고도화, v2.3 운영 검증 및 외부 연동 실체화, v2.4 Knowledge+Economy 심화

**현재 마일스톤:** 다음 마일스톤 계획 대기

**최근 완료:** v2.4는 daily wiki projector, graphify projector, coin ledger atomicity, settlement governance hardening, scheduled consistency linting을 완료하고 Phase 30-32 closure로 milestone audit gaps를 닫았다. 최종 re-audit은 requirements 24/24, phases 5/5, integration 5/5, flows 5/5로 `passed`다.

**현재 진행:** fresh `REQUIREMENTS.md`는 삭제된 상태다. 다음 작업은 `$gsd-new-milestone`으로 새 milestone scope, 요구사항, roadmap을 정의하는 것이다.

**v2.4 delivered:**
- Board/domain event를 daily wiki page, date index, chronological log, per-user page로 project한다.
- Daily wiki output을 confidence-tagged graph, incremental refresh, graph report, community evidence로 연결한다.
- Coin ledger는 atomic `balanceAfter`, debit/credit `leg`, transaction rollback, reconciliation, non-negative balance protection을 갖는다.
- Settlement governance는 duplicate materialization guard, linked ledger evidence, anti-gaming signal, company threshold settings를 갖는다.
- Wiki consistency lint는 scheduled, evidence-only 방식으로 실행되고 `embedding_consistency` issue type을 포함한다.
- Phase 30-32가 WIKI/GRAPH/LEDGER/SETTLE/LINT traceability gaps를 닫아 final milestone re-audit을 통과했다.

v2.3에서 완료한 것:

- Phase 14-18 `VALIDATION.md`와 skipped route suite를 보강해 v2.2 검증 부채를 닫았다.
- SSO provider metadata validation, SCIM sync preview, rollout readiness audit log를 실제 운영 흐름으로 만들었다.
- Obsidian-compatible local writer와 bidirectional sync conflict resolution을 preview-only 상태에서 승인 가능한 sync flow로 고도화했다.
- 산출물 가격 협상, settlement approval, anti-gaming signal을 gold ledger/P&L/audit log와 연결했다.
- Trello advanced parity와 mobile/native inbound queue 검수 흐름을 완성했다.

v2.0-v2.2에서 완료한 것:

- RT2-first company shell과 navigation.
- deliverable/base-price 구조를 가진 One-Liner work capture.
- RT2 execution lifecycle persistence, append-only event stream, projector tracking.
- cumulative wiki page와 provenance-aware graph projection.
- evidence-backed Jarvis, quality mode, hybrid search.
- ledger-backed P&L, marketplace evidence, derived collaboration reward.
- 개발기획서 alignment checklist와 gap visibility.
- daily report cockpit, OKR/KPI traceability, Task Mesh, Knowledge Bridge, enterprise rollout readiness.
- 일일업무일지 3칸 Trello형 drag/drop, RealTycoon2 identity hardening, Trello 기반 업무 보드.

## 요구사항

### 검증 완료

- [x] RT2 primary shell과 company-scoped information architecture - v2.0
- [x] base-price 구조를 가진 deliverable-aware One-Liner capture - v2.0
- [x] work object에 연결된 RT2 execution lifecycle persistence - v2.0
- [x] append-only RT2 event stream과 replay-safe projector state - v2.0
- [x] cumulative wiki page와 provenance-aware graph projection - v2.0
- [x] evidence-backed Jarvis, quality mode, hybrid search - v2.0
- [x] ledger-backed P&L, marketplace evidence, collaboration reward - v2.0
- [x] 개발기획서 alignment checklist와 gap visibility - v2.1
- [x] floating, shortcut, voice, messenger-style One-Liner capture - v2.1
- [x] daily report cockpit과 OKR/KPI traceability - v2.1
- [x] Task Mesh와 wiki/graph/Obsidian-ready knowledge workflow - v2.1
- [x] Jarvis Shadow/Co-Pilot/Auto change-management hardening - v2.1
- [x] enterprise rollout setting, portable template, binding mode, RT2 terminology cleanup - v2.1
- [x] 일일업무일지 3칸 Trello형 drag/drop 및 즉시 저장 - v2.2
- [x] 개발기획서 alignment scorecard와 product-facing RealTycoon2 identity hardening - v2.2
- [x] Trello 기반 RealTycoon2 업무 보드, Task/To-Do 카드, 산출물/가격/OKR badge, 빠른 편집 - v2.2
- [x] messenger/mobile/native One-Liner inbound draft contract와 검수 route - v2.2
- [x] Knowledge Bridge의 vault export/import preview, graph report, evidence status 운영 흐름 - v2.2
- [x] Marketplace/P&L/enterprise rollout evidence와 저장 설정값 hydrate - v2.2
- [x] v2.3 검증 및 안정화 요구사항 3개.
- [x] v2.3 enterprise rollout 요구사항 3개.
- [x] v2.3 Knowledge Bridge 요구사항 3개.
- [x] v2.3 economy/governance 요구사항 3개.
- [x] v2.3 work board/capture 요구사항 5개.
- [x] v2.3 Phase 19 verification artifact closure.
- [x] v2.4 Daily Wiki/Graphify 요구사항 11개.
- [x] v2.4 Ledger/Settlement 요구사항 9개.
- [x] v2.4 Consistency Lint 요구사항 4개.
- [x] v2.4 Phase 30-32 milestone audit gap closure.

### 진행 중

- 다음 마일스톤 요구사항은 아직 정의하지 않았다.

### 범위 밖

- backend/data platform greenfield rewrite. 작동 중인 server, db, auth, approval, audit invariant를 보존한다.
- web One-Liner와 operator loop가 내부 사용에서 안정화되기 전 native mobile app distribution.
- trusted company ecosystem 밖의 public/open marketplace.
- v2.4 이후 vector embedding + semantic search는 pgvector 준비 후 별도 milestone으로 다룬다.
- live provider-backed contradiction detection은 deterministic lint analyzer가 안정화된 뒤 hardening한다.

## Context

- v2.0은 이전 planning artifact가 실제 repo 상태보다 completion을 과장했기 때문에 corrective milestone이었다.
- 현재 RT2 경로는 brownfield다. 안정적인 Paperclip-derived infrastructure는 계속 유용하지만, 제품 정체성과 business truth는 RT2-first다.
- Windows local verification은 Codex filesystem sandbox 안에서 Vitest/build tooling이 `spawn EPERM`을 만날 수 있어 승인된 unsandboxed command execution이 필요할 수 있다.
- 두 historical UAT file은 close audit에서 `unknown`으로 보고되었고 pending scenario는 0개였다. active blocker가 아니라 deferred audit artifact로 기록한다.
- v2.2 audit은 blocker 없이 `tech_debt`로 종료했다. 주요 부채는 Phase 14-18 `VALIDATION.md` 누락, 일부 route test의 embedded Postgres skip, 외부 연동 깊이의 후속 범위다.
- v2.3은 Phase 19-24에서 검증 부채와 개발기획서 remaining 6% gap을 실제 운영 기능과 감사 가능한 검증 산출물로 닫았다.
- v2.4는 daily wiki projector -> graphify -> ledger atomicity -> settlement hardening -> batch linting으로 knowledge/economy 깊이를 더했고, Phase 30-32에서 strict milestone traceability를 복구했다. 최종 re-audit은 `passed`다.

## 제약

- **Tech stack:** Express + React/Vite + Drizzle + Postgres/PGlite.
- **Product safety:** company boundary, activity logging, approval, budget control, auditability를 유지해야 한다.
- **Architecture:** high-contention business data는 event-first RT2 write와 projector-backed read model을 선호한다.
- **Identity:** RealTycoon2 first. upstream project는 reference와 infrastructure ingredient일 뿐이다.

## 주요 결정

| 결정 | 이유 | 결과 |
|------|------|------|
| 이전 M2-M4 completion claim을 execution planning 기준으로 신뢰하지 않음 | repo에는 RT2 plan을 end-to-end로 충족하지 못하는 partial implementation과 stub이 있었다 | 좋음 - v2.0이 baseline을 바로잡음 |
| old roadmap을 계속하지 않고 corrective RT2 refoundation milestone 시작 | 이전 roadmap은 신뢰할 수 있는 execution guide가 아니었다 | 좋음 - v2.0 완료 |
| stable server/db/shared asset을 선택적으로 재사용하면서 RT2 product surface를 재구성 | UI shell, route tree, nested RT2 panel이 product-shape drift의 주된 원인이었다 | 좋음 - RT2가 primary가 됨 |
| logging, wiki, graph, search, economy에 CQRS/projection을 필수화 | RT2 plan은 low-conflict write와 asynchronous materialization을 요구한다 | 좋음 - event/projector infrastructure 존재 |
| `--auto --chain` 실행 중 mechanical cleanup은 inline 처리 | wave-by-wave ceremony가 단순 verification fix를 느리게 했다 | 좋음 - operating preference로 기록 |
| v2.1 close 후 REQUIREMENTS.md를 archive하고 새 milestone에서 다시 생성 | 요구사항 파일이 milestone-scoped여야 다음 milestone scope가 섞이지 않는다 | 좋음 - 다음 milestone planning이 명확해짐 |
| v2.2와 v2.3은 기능 완료와 검증 부채를 분리해 기록 | strict validation artifact가 없으면 shipped와 debt를 같이 남겨야 한다 | 좋음 - 후속 gap closure가 가능해짐 |
| Paperclip/Multica 명칭은 product-facing이 아니라 engine/internal compatibility layer로만 유지 | 사용자가 RealTycoon2가 장식처럼 보이는 위험을 명확히 지적했다 | 좋음 - 제품 표면은 RT2/Trello형 업무 흐름으로 전환 |
| v2.4는 knowledge projection과 economy governance 심화를 5개 기능 phase와 3개 closure phase로 완료 | initial audit gaps를 숨기지 않고 Phase 30-32에서 artifact coverage를 복구했다 | 좋음 - final re-audit `passed` |

## 다음 마일스톤 목표

다음 마일스톤은 아직 정의하지 않았다. `$gsd-new-milestone`으로 새 `REQUIREMENTS.md`와 `ROADMAP.md` scope를 생성한다.

---
*마지막 업데이트: 2026-04-28, v2.4 milestone shipped*
