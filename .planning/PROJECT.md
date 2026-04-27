# RealTycoon2

## 이 프로젝트가 무엇인가

RealTycoon2는 iSens Corp. 내부에서 사람과 AI 팀이 함께 쓰는 회사 운영 시스템이다. RT2 work logging, deliverable management, execution lifecycle state, cumulative wiki/graph knowledge, Jarvis assistance, quality evaluation, governance, amoeba-style economic feedback을 하나의 company-scoped operating loop로 묶는다.

Paperclip-derived control-plane 자산은 제품 정체성이 아니라 infrastructure와 reference material로 취급한다. RealTycoon2의 business truth는 RT2-controlled schema, service, API, projection, UI surface에 있어야 한다.

## 핵심 가치

회사 범위 work signal은 disconnected tool이나 Paperclip-shaped manual workflow를 강요하지 않고 logging → execution → knowledge accumulation → approval → economic feedback으로 이어져야 한다.

## 현재 상태

**완료된 마일스톤:** v2.0 RT2 Refoundation, v2.1 개발기획서 반영 및 운영자 채택, v2.2 개발기획서 완전 정합성 고도화, v2.3 운영 검증 및 외부 연동 실체화

**현재 마일스톤:** v2.4 Knowledge+Economy 심화 (Phase 25-29)

**최근 완료:** v2.3은 v2.2에서 `tech_debt`로 남긴 검증 산출물과 개발기획서 remaining 6% gap을 실제 운영 가능한 외부 연동, 지식 동기화, settlement governance, advanced board/capture 흐름으로 닫았다.

**현재 진행:** v2.4는 daily wiki projector → graphify projector → coin ledger atomicity → settlement governance hardening → consistency linting으로 knowledge/economy 심화를推进한다.

**v2.3 delivered:**
- Phase 14-18 `VALIDATION.md`와 skipped route suite를 보강해 v2.2 검증 부채를 닫는다.
- SSO provider metadata validation, SCIM sync preview, rollout readiness audit log를 실제 운영 흐름으로 만든다.
- Obsidian-compatible local writer와 bidirectional sync conflict resolution을 preview-only 상태에서 승인 가능한 sync flow로 고도화한다.
- 산출물 가격 협상, settlement approval, anti-gaming signal을 gold ledger/P&L/audit log와 연결한다.
- Trello advanced parity(checklist, due date, attachment preview, filter/sort)와 mobile/native inbound queue 검수 흐름을 완성한다.

v2.0에서 완료한 것:

- RT2-first company shell과 navigation.
- task, todo, deliverable, daily-log, base-price field를 생성하는 One-Liner work capture.
- enqueue, claim, start, complete, fail, retry를 위한 execution-attempt lifecycle record.
- append-only RT2 domain event와 projector tracking.
- cumulative wiki page와 provenance-aware graph projection.
- evidence-backed Jarvis, Shadow/Co-Pilot/Auto quality mode, hybrid search.
- ledger-backed P&L, marketplace evidence, derived collaboration reward.

v2.1에서 완료한 것:

- 앱을 업로드된 RealTycoon2 개발기획서와 비교하고 명시적인 gap map을 유지한다.
- v2.0 RT2 spine을 운영자-ready daily workflow로 바꾼다.
- friction-zero capture, daily report cockpit, OKR/KPI traceability, task mesh, knowledge sync, Jarvis change management, enterprise rollout readiness를 완료했다.

## 요구사항

### 검증 완료

- [x] RT2 primary shell과 company-scoped information architecture - v2.0
- [x] base-price 구조를 가진 deliverable-aware One-Liner capture - v2.0
- [x] work object에 연결된 RT2 execution lifecycle persistence - v2.0
- [x] append-only RT2 event stream과 replay-safe projector state - v2.0
- [x] cumulative wiki page와 provenance-aware graph projection - v2.0
- [x] evidence-backed Jarvis, quality mode, hybrid search - v2.0
- [x] ledger-backed P&L, marketplace evidence, collaboration reward - v2.0
- [x] brownfield baseline의 company-scoped control-plane entity, approval, budget, activity logging 유지 - current infrastructure
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

### 진행 중

- [x] v2.3 검증 및 안정화 요구사항 3개.
- [x] v2.3 enterprise rollout 요구사항 3개.
- [x] v2.3 Knowledge Bridge 요구사항 3개.
- [x] v2.3 economy/governance 요구사항 3개.
- [x] v2.3 work board/capture 요구사항 5개.
- [x] v2.3 Phase 19 verification artifact closure.

### 범위 밖

- backend/data platform greenfield rewrite. 작동 중인 server, db, auth, approval, audit invariant를 보존한다.
- web One-Liner와 operator loop가 내부 사용에서 안정화되기 전 native mobile app distribution.
- trusted company ecosystem 밖의 public/open marketplace.

## Context

- v2.0은 이전 planning artifact가 실제 repo 상태보다 completion을 과장했기 때문에 corrective milestone이었다.
- 현재 RT2 경로는 brownfield다. 안정적인 Paperclip-derived infrastructure는 계속 유용하지만, 제품 정체성과 business truth는 RT2-first다.
- Windows local verification은 Codex filesystem sandbox 안에서 Vitest/build tooling이 `spawn EPERM`을 만날 수 있어 승인된 unsandboxed command execution이 필요할 수 있다.
- 두 historical UAT file은 close audit에서 `unknown`으로 보고되었고 pending scenario는 0개였다. active blocker가 아니라 deferred audit artifact로 기록한다.
- v2.1 planning은 runtime에 local PDF text extraction tool이 없어 업로드 개발기획서의 markdown conversion을 사용했다.
- v2.1은 Phase 8-13, 6개 plan, 24개 요구사항을 완료했다.
- v2.2는 Phase 14-18, 5개 plan, 11개 요구사항을 완료했다.
- v2.2 audit은 blocker 없이 `tech_debt`로 종료했다. 주요 부채는 Phase 14-18 `VALIDATION.md` 누락, 일부 route test의 embedded Postgres skip, 외부 연동 깊이의 후속 범위다.
- v2.3은 Phase 19-24로 이어가며, v2.2의 검증 부채와 개발기획서 remaining 6% gap을 실제 운영 기능과 감사 가능한 검증 산출물로 닫았다. 재감사 결과 요구사항 17/17, phases 6/6, integration 5/5, flows 5/5가 충족되었고 strict Nyquist `*-VALIDATION.md`는 tech debt로 이월했다.
- Phase 22는 approved deliverable 기반 settlement flow, 가격 제안/근거/협상 코멘트, approval gate, 승인/반려, gold ledger/P&L/audit log 반영, self-review/gold farming/quality bias signal을 완료했다.
- Phase 23은 Trello advanced checklist/due/quality/price/attachment metadata, board filter/sort, mobile/native capture draft queue, Task/To-Do/Deliverable promotion, duplicate/permission/source failure audit tracking을 완료했다.

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
| 개발기획서 alignment audit로 v2.1 시작 | 사용자가 수정 전에 앱이 업로드된 계획을 얼마나 반영했는지 확인하라고 요청했다 | 좋음 - concrete gap map과 phase roadmap 생성 |
| v2.1 close 후 REQUIREMENTS.md를 archive하고 새 milestone에서 다시 생성 | 요구사항 파일이 milestone-scoped여야 다음 milestone scope가 섞이지 않는다 | 좋음 - v2.2 planning 준비 |
| v2.2는 `tech_debt` 상태로 완료 | 요구사항과 통합 flow는 닫혔지만 Nyquist `VALIDATION.md`는 없었다 | 좋음 - 기능 완료와 검증 부채를 분리해 기록 |
| Paperclip/Multica 명칭은 product-facing이 아니라 engine/internal compatibility layer로만 유지 | 사용자가 RealTycoon2가 장식처럼 보이는 위험을 명확히 지적했다 | 좋음 - 제품 표면은 RT2/Trello형 업무 흐름으로 전환 |
| v2.3은 검증 부채와 외부 연동 깊이를 하나의 운영화 마일스톤으로 묶음 | 남은 gap이 독립 신기능보다 실제 검증 가능한 운영 깊이에 집중되어 있다 | 좋음 - 요구사항 17/17 충족, audit `tech_debt`로 완료 |
| v2.4는 knowledge projection과 economy governance 심화를 5개 phase로 구성 | daily wiki/graphify가 foundation, ledger atomicity가 governance prerequisite, linting이 마지막 | 진행 중 - phase 순서는 의존성 반영 |

## 현재 마일스톤 목표

**v2.4 Knowledge+Economy 심화** — Phase 25-29에서 knowledge projection과 economy governance의 심화 기능을 구현한다.

**Phase 25 Daily Wiki Projector**: board event(todo.created, todo.updated, task.completed 등)를 자동으로 daily wiki page로 생성. index.md, log.md, per-user daily page를 지원하고 `appendAndProject()`로 knowledge_core chain에 추가. replay-safe, idempotent保证.

**Phase 26 Graphify Projector**: daily wiki 기반 knowledge graph projection. graph_cache hash로 incremental refresh. edge에 EXTRACTED/INFERRED/AMBIGUOUS confidence tag 표시. Leiden algorithm로 community detection. GRAPH_REPORT.md 생성.

**Phase 27 Coin Ledger Atomicity**: `balanceAfter` SQL subquery 원자적 계산. income/expense pair를 `db.transaction()`으로 감싸 atomic rollback 보장. cross-table P&L reconciliation. `leg` column ('debit'/'credit') 추가. `balance_after >= 0` constraint.

**Phase 28 Settlement Governance Hardening**: `(companyId, workProductId)` unique constraint으로 double materialization 방지. anti-gaming signal (repeated_self_review, abnormal_gold_farming, quality_score_bias) settlement approval UI에 표시. configurable threshold UI per company.

**Phase 29 Consistency Linting (Batch)**: nightly batch LLM scan으로 wiki page 간 contradiction 탐지. lint issue는 evidence와 함께 flag (auto-fix 없음). `rt2WikiLintService`에 `embedding_consistency` check 추가. schedule-based execution (not on-write).

---
*마지막 업데이트: 2026-04-27, v2.4 milestone started*
