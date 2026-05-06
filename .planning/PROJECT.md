# RealTycoon2

## 이 프로젝트가 무엇인가

RealTycoon2는 iSens Corp. 내부에서 사람과 AI 팀이 함께 쓰는 회사 운영 시스템이다. RT2 work logging, deliverable management, execution lifecycle state, cumulative wiki/graph knowledge, Jarvis assistance, quality evaluation, governance, amoeba-style economic feedback을 하나의 company-scoped operating loop로 묶는다.

Paperclip-derived control-plane 자산은 제품 정체성이 아니라 infrastructure와 reference material로 취급한다. RealTycoon2의 business truth는 RT2-controlled schema, service, API, projection, UI surface에 있어야 한다.

## 핵심 가치

회사 범위 work signal은 disconnected tool이나 Paperclip-shaped manual workflow를 강요하지 않고 logging -> execution -> knowledge accumulation -> approval -> economic feedback으로 이어져야 한다.

## 현재 상태

**완료된 마일스톤:** v2.0~v3.5 모두 완료 (v3.5 2026-05-05 shipped)

## Current Milestone: v3.6 — RT2 Engine Consolidation

**Goal:** event/projector 시스템 하드닝, work entity 무결성 보장, board 성능 최적화, error handling/recovery 개선.

**Target features:**
- Event System Reliability (at-least-once delivery, projector replay, retry with backoff) — Phase 93
- Work Entity Integrity (atomic transitions, auto-repair, indexed queries) — Phase 94
- Board Performance Optimization (< 200ms overview, no N+1, indexed counts) — Phase 95
- Error Handling & Recovery (retry UI, local auto-save, startup validation) — Phase 96

## Next Milestone Goals

- v3.6: RT2 Engine Consolidation (Phase 93-96)
- v3.5 shipped (2026-05-05). Phase 89-92 complete.
- Phase 93 plan부터 시작합니다. `/gsd-plan-phase 93`으로 plan을 작성하세요.

## Current State After v3.0

v3.0 Native Distribution Readiness는 2026-05-01에 archive됐다. RealTycoon2는 아직 web/PWA-first repo지만, signed native distribution, release channel, updater, resident desktop entry, mobile push까지 운영자가 검증할 수 있는 evidence-first gate를 갖췄다.

**Target features:**
- Native shell packaging 후보, signing credential inventory, platform capability boundary를 확정한다. - Phase 59 완료
- macOS Developer ID signing, hardened runtime, notarization, ticket stapling/Gatekeeper verification을 release gate에 넣는다. - Phase 60 완료
- Windows MSIX/installer signing, timestamping, Store re-signing 또는 trusted signing path를 release gate에 넣는다. - Phase 60 완료
- Internal/beta/stable release channel, signed updater feed, rollback candidate, rollout evidence를 관리한다. - Phase 61 완료
- Resident tray/menubar app과 OS-level global shortcut이 v2.9 draft review loop로 빠른 입력을 전달하게 한다. - Phase 62 완료
- Mobile/Web Push/APNs token, delivery/retry/failure/click evidence를 company-scoped notification loop로 연결한다. - Phase 63 완료
- Phase 60-63 evidence summary와 v2.9 capture regression evidence를 final distribution gate로 묶는다. - Phase 64 완료

**Deferred from this milestone:**
- Cross-company federation full apply.
- Autonomous Jarvis apply without approval.
- Public/open company capture marketplace.
- Public store listing launch, marketing, reviewer account operations.

## Next Milestone Goals

- v3.1은 새 기능 확장보다 DevPlan Core Convergence에 집중한다.
- 완료 주장의 과장을 줄이고, 개발기획서 alignment를 장/핵심 축별 code/UI/test/evidence와 연결한다.
- Paperclip residue, Daily 3패널 cockpit, OKR rollup, Multica runtime, wikiLLM living memory, Graphify v3 sidecar, Marketplace/P&L/CareerMate loop를 phase 단위로 닫는다.
- v3.0 distribution evidence gates는 유지하되 이번 milestone의 중심 scope가 아니다.

## 최근 마일스톤: v2.9 Native Capture and Draft Reliability

**Goal:** One-Liner와 board review flow를 저장 가능한 draft revision 기반으로 안정화하고, native/mobile/messaging quick capture entry가 같은 검수 루프로 들어오게 만든다.

**Delivered:**
- Persistent capture draft revision, latest revision promotion, Korean board review edit/state actions.
- PWA/mobile quick capture route, bounded local queue, mobile source handoff, RealTycoon2 manifest identity.
- Slack/Teams/webhook source setup, signed public inbound route, redacted source metadata, malformed/source failure evidence.
- Board review inbox source/status/evidence filters, promoted draft evidence labels, source-level capture reliability report.
- Phase 58 validation/verification artifact closure and v2.9 traceability sync.

**Distribution boundary:** Full app-store signing/updater/notarization, release channel, resident tray, OS-level global shortcut, mobile push, and final release acceptance are v3.0 evidence-gated surfaces. Public store operations remain future scope.

## 최근 마일스톤: v2.8 RealTycoon2 Product Identity and Daily Work UX

**Goal:** 앱을 구동했을 때 RealTycoon2가 Paperclip-derived 도구가 아니라 한국어 일일 업무 운영 시스템으로 즉시 인식되도록 제품 정체성과 핵심 보드 UX를 완성한다.

**Target features:**
- 앱 구동, 첫 화면, 네비게이션, 빈 상태, 설정, 기본 문구에서 Paperclip/Paper Company/영문 기본값 노출을 제거하고 RealTycoon2-first Korean UX로 정리한다.
- 일일업무일지 중심 3단 Trello형 칸반보드를 핵심 작업 화면으로 강화한다. - Phase 49 완료
- Task/To-Do/Deliverable/가격/품질/OKR badge가 카드에서 바로 이해되고 빠르게 편집되는 흐름을 만든다.
- One-Liner capture가 보드와 자연스럽게 이어져 기록 -> 분류 -> 실행 -> 산출물 흐름을 형성한다. - Phase 51 완료
- Jarvis, wiki, graph, economy 기능은 보조 패널, evidence, recommendation surface로 배치해 제품 정체성을 방해하지 않게 한다.

**Deferred from this milestone:**
- Cross-company federation full apply.
- Full app-store native distribution.
- Autonomous Jarvis apply without approval.
- Mandatory provider-only eval path.

## 최근 마일스톤: v2.7 릴리즈 호스트 검증 및 런타임 신뢰도

**Goal:** v2.6에서 남은 verification/runtime confidence 부채를 release-host 재현성, embedded Postgres coverage, artifact metadata consistency, operator-visible confidence evidence로 닫는다.

**Target features:**
- Full `pnpm typecheck && pnpm test`가 release-host 기준에서 timeout 원인과 owner를 남기며 재시도 가능한 gate로 동작한다. - Phase 44 완료
- Embedded Postgres persistence/route suites가 Windows 기본 실행에서 skip으로 사라지지 않고 opt-in 또는 host-ready path로 검증된다. - Phase 45 완료
- Phase validation metadata, legacy UAT closure, milestone artifact gate가 같은 truth를 보고하도록 정렬된다.
- 운영자가 release confidence와 남은 validation debt를 앱/문서/CLI evidence에서 확인할 수 있다.

## 최근 마일스톤: v2.6 운영 커넥터 및 자율성 하드닝

**Goal:** v2.5에서 닫은 semantic knowledge loop를 실제 외부 운영 경계, mobile/native capture, Jarvis autonomy guardrail, validation gate까지 확장해 운영 가능한 hardening layer로 만든다.

**Delivered:**
- 실제 IdP handshake 검증과 SCIM apply mutation을 audit 가능한 rollout connector flow로 고도화했다.
- Obsidian/local knowledge bridge를 trusted daemon/pairing/health 기반 운영 흐름으로 만들었다.
- Slack/Teams/native/mobile capture source를 설치, 검수, promotion, semantic search UX까지 hardening했다.
- Jarvis autonomous knowledge rewrite 제안을 provider-backed eval, deterministic fallback, approval evidence, production monitoring으로 제한했다.
- Phase 19-24 strict validation debt와 legacy UAT unknown 항목을 닫고 milestone artifact gate를 강화했다.

**v2.5 delivered:**
- Company-scoped semantic index storage, deterministic fallback embedding, and incremental reindex inspection.
- Semantic + lexical RT2 knowledge search across daily wiki, graph, work artifact, and deliverable evidence.
- Contradiction candidate generation, resolution decisions, activity-log audit, and freshness integration.
- Jarvis grounded answers with citations, stale evidence warnings, unresolved contradiction warnings, and routable citation targets.
- Knowledge operations health route and dashboard gate for semantic index, contradiction review, and Jarvis grounding.
- Phase 38 artifact closure for missing verification, validation, summary frontmatter, and requirement traceability.

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
- [x] v2.5 Semantic Index 요구사항 4개.
- [x] v2.5 Semantic Search 요구사항 4개.
- [x] v2.5 Contradiction Review 요구사항 4개.
- [x] v2.5 Jarvis Grounding 요구사항 4개.
- [x] v2.5 Knowledge Operations 요구사항 3개.
- [x] v2.5 Phase 38 artifact closure.
- [x] v2.6 external connector apply loop 요구사항 2개. - Phase 39
- [x] v2.6 trusted local bridge 요구사항 1개. - Phase 40
- [x] v2.6 native/mobile capture hardening 요구사항 3개. - Phase 41
- [x] v2.6 autonomy/evals hardening 요구사항 3개. - Phase 42
- [x] v2.6 validation closure 요구사항 3개. - Phase 43
- [x] v2.7 release-host verification 요구사항 3개. - Phase 44
- [x] v2.7 embedded Postgres runtime coverage 요구사항 3개. - Phase 45
- [x] v2.7 artifact/UAT truth alignment 요구사항 3개. - Phase 46
- [x] v2.7 runtime confidence operations surface 요구사항 2개. - Phase 47
- [x] v2.8 identity 요구사항 4개. - Phase 48
- [x] v2.8 daily work board 요구사항 5개. - Phase 49-50, Phase 53 검증
- [x] v2.8 One-Liner capture flow 요구사항 3개. - Phase 51, Phase 53 검증
- [x] v2.8 supporting surfaces 요구사항 3개. - Phase 52, Phase 53 검증
- [x] v2.9 draft reliability 요구사항 4개. - Phase 54, Phase 58 검증
- [x] v2.9 native/mobile quick capture 요구사항 3개. - Phase 55, Phase 58 검증
- [x] v2.9 messaging capture 요구사항 3개. - Phase 56, Phase 58 검증
- [x] v2.9 review operations 요구사항 3개. - Phase 57, Phase 58 검증
- [x] v3.0 Native Distribution Readiness 요구사항 12개 중 12개 완료. Phase 59-64 complete.

### 다음 요구사항

- [x] v3.1 DevPlan truth and traceability 요구사항 3개. - Phase 65
- [x] v3.1 RealTycoon2 identity cleanup 요구사항 3개. - Phase 65
- [x] v3.1 Daily Work and OKR cockpit 요구사항 3개. - Phase 66
- [x] v3.1 Multica runtime alignment 요구사항 3개. - Phase 67
- [x] v3.1 wikiLLM living memory 요구사항 3개. - Phase 68
- [x] v3.1 Graphify v3 engine alignment 요구사항 4개. - Phase 69
- [x] v3.1 Economy/Marketplace/P&L/CareerMate loop 요구사항 3개. - Phase 70
- [x] v3.1 acceptance gate 요구사항 2개. - Phase 71
- [x] v3.4 RT2 Event/Projector Layer 요구사항 3개. - Phase 84
- [x] v3.4 API Contract Alignment 요구사항 1개 (API-01). - Phase 85
- [x] v3.4 Work Entity Migration 요구사항 3개. - Phase 86
- [x] v3.4 RT2 Schema Validation 요구사항 3개. - Phase 87
- [x] v3.4 Acceptance Gate 요구사항 4개. - Phase 88
- [ ] v3.4 API versioning strategy (API-02). - deferred to future scope
- [ ] v3.4 backward compatibility migration path (API-03). - deferred to future scope

### 범위 밖

- backend/data platform greenfield rewrite. 작동 중인 server, db, auth, approval, audit invariant를 보존한다.
- v2.9 DRAFT/NATIVE/MSG/REVIEW capture behavior 재개발. v3.0에서는 regression gate 실패를 고치는 경우만 허용한다.
- trusted company ecosystem 밖의 public/open marketplace.
- v2.5 이후 cross-company knowledge federation은 trusted company ecosystem 밖이므로 제외한다.
- v2.5 이후 autonomous knowledge rewrites는 approval-first contradiction review가 안정화된 뒤 다룬다.
- public store listing launch/marketing/reviewer operations는 signing/updater/notarization readiness 이후 별도 scope로 다룬다.
- Graphify upstream code를 무비판적으로 vendor-in 하는 방식은 제외한다. RT2 product graph와 corpus graph boundary를 먼저 고정한다.
- v3.0에서 정의한 실제 native signing credential, APNs/Web Push provider secret, public store 운영 증거 수집은 v3.1의 중심 scope가 아니다.

## Context

- v2.0은 이전 planning artifact가 실제 repo 상태보다 completion을 과장했기 때문에 corrective milestone이었다.
- 현재 RT2 경로는 brownfield다. 안정적인 Paperclip-derived infrastructure는 계속 유용하지만, 제품 정체성과 business truth는 RT2-first다.
- Windows local verification은 Codex filesystem sandbox 안에서 Vitest/build tooling이 `spawn EPERM`을 만날 수 있어 승인된 unsandboxed command execution이 필요할 수 있다.
- 두 historical UAT file은 close audit에서 `unknown`으로 보고되었고 pending scenario는 0개였다. active blocker가 아니라 deferred audit artifact로 기록한다.
- v2.2 audit은 blocker 없이 `tech_debt`로 종료했다. 주요 부채는 Phase 14-18 `VALIDATION.md` 누락, 일부 route test의 embedded Postgres skip, 외부 연동 깊이의 후속 범위다.
- v2.3은 Phase 19-24에서 검증 부채와 개발기획서 remaining 6% gap을 실제 운영 기능과 감사 가능한 검증 산출물로 닫았다.
- v2.4는 daily wiki projector -> graphify -> ledger atomicity -> settlement hardening -> batch linting으로 knowledge/economy 깊이를 더했고, Phase 30-32에서 strict milestone traceability를 복구했다. 최종 re-audit은 `passed`다.
- v2.5는 semantic index -> semantic search -> contradiction review -> Jarvis grounding -> operations health gate로 지식 루프를 닫았고, Phase 38에서 strict milestone traceability를 복구했다. 최종 re-audit은 `passed`다.
- v2.6은 external connector apply, trusted local bridge, native/mobile capture, Jarvis autonomy/evals, validation closure로 운영 경계를 hardening했다. Audit은 blocker 없이 `tech_debt`다.
- v2.7은 release-host reproducibility, embedded Postgres accepted-debt evidence, artifact gate truth, runtime confidence generated report를 완료했다. Audit은 blocker 없이 `tech_debt`이며 Windows default embedded Postgres skip은 focused host-ready command로 닫는 accepted debt다.
- v2.8은 RealTycoon2 product-facing identity와 한국어 daily work UX를 완료했다. Daily board가 primary work surface가 되었고 One-Liner capture, card quick edit, support evidence, identity regression gate가 연결됐다. Audit은 `passed`다.
- v2.8 close verification에서 `pnpm typecheck`, focused Vitest 26 tests, identity gate test/scan은 통과했다. Broad `pnpm test`는 `server/src/__tests__/workspace-runtime.test.ts` provision-command case timeout으로 실패해 accepted debt로 남겼다.
- v2.9는 persistent draft revision, PWA/mobile quick capture, signed messaging inbound, capture review operations, source-level reliability report를 완료했다. Phase 58이 validation/verification artifact drift와 traceability를 닫았다.
- 현재 repo는 Electron/Tauri 같은 native shell dependency가 없는 web/PWA-first 상태다. v3.0 Phase 59는 Tauri v2를 native shell baseline으로 선택하고 `apps/desktop` future package layout, signing/updater/channel inventory, v2.9 regression gate boundary를 확정했다.
- Phase 60은 native signing evidence gate를 추가해 macOS Developer ID/hardened runtime/codesign/notarization/stapling/Gatekeeper evidence와 Windows trust path/signing/timestamping/signature verification/install trust evidence를 검증하고 `.planning/native-signing-runs/` report로 남긴다.
- Phase 61은 release channel/signed updater evidence gate를 추가해 internal/beta/stable channel metadata, updater signature/checksum, rollout/rollback, installed/update state, Phase 60 signing prerequisite, secret hygiene evidence를 검증하고 `.planning/native-updater-runs/` report로 남긴다.
- Phase 62는 resident surface evidence gate를 추가해 tray/menubar status, global shortcut lifecycle, privacy boundary, native capture handoff, macOS/Windows resident evidence를 검증하고 `.planning/native-resident-runs/` report로 남긴다.
- Phase 63은 push notification evidence gate를 추가해 Mobile/Web Push/APNs registration scope, minimal payload target, delivery/retry/invalid-token handling, notification click-through, capture reliability metrics, secret hygiene evidence를 검증하고 `.planning/native-push-runs/` report로 남긴다.
- Phase 64는 final distribution gate를 추가해 Phase 60-63 summary evidence, stale updater/wrong channel/build checks, focused v2.9 regression evidence, secret hygiene를 하나의 배포 차단 조건으로 묶고 `.planning/native-distribution-gate-runs/` report로 남긴다.
- macOS/Windows 실제 signing credential은 repo에 저장하지 않고 manifest evidence와 secret reference로만 다룬다.
- Mobile push는 APNs/Web Push/device token을 company/user/device scope로 관리하고 최소 payload/deep-link 방식으로 board review target에 연결하는 evidence gate를 갖췄다.
- 2026-05-01 개발기획서 재점검에서 현재 repo의 정적 싱크로율은 약 64%로 판단했다. 방향성은 맞지만 제품 핵심 루프와 엔진 parity가 아직 부족하다.
- `.planning/research/ENGINE-REFERENCE-AUDIT.md`는 Multica를 runtime/daemon/queue reference로, Graphify v3를 corpus graph sidecar reference로 삼아야 한다고 결론냈다.
- v3.1은 distribution 확장이 아니라 DevPlan Core Convergence다. Phase 65-71은 과장된 completion claim을 줄이고 실제 제품/엔진 증거를 맞추는 데 집중한다.
- Phase 65는 개발기획서 alignment matrix, RealTycoon2 compatibility boundary, docs/server-facing identity scan, 64% 기준선 UI, DevPlan alignment gate를 완료했다.
- Phase 66은 Daily Work 3패널 cockpit, One-Liner review/capture evidence, Mission -> To-Do hierarchy rollup을 공유 contract, server read model, UI, focused tests로 닫았고 DevPlan alignment score를 72%로 올렸다.
- Phase 67은 RT2 execution을 `dispatched` 중심 transition guard, runtime capacity dispatch, heartbeat/timeline/cancel/stale cleanup evidence, work card/Jarvis surface로 닫았고 DevPlan alignment score를 79%로 올렸다.
- Phase 68은 wikiLLM-compatible `index.md`/`log.md`/topic/project/schema export, provenance/confidence/contradiction/update evidence, Jarvis wiki citation/rewrite apply loop, Knowledge/Daily/Quality UI evidence를 닫았고 DevPlan alignment score를 83%로 올렸다.

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
| v2.5는 semantic knowledge intelligence를 5개 기능 phase와 1개 closure phase로 완료 | semantic index/search/contradiction/Jarvis/operations 기능 구현 후 Phase 38에서 artifact coverage를 복구했다 | 좋음 - final re-audit `passed` |
| v2.6은 운영 경계 hardening을 blocker 없이 닫고 full-suite timeout을 tech debt로 기록 | targeted checks와 artifact gate는 통과했지만 Windows full-suite completion은 재확인이 필요했다 | 좋음 - milestone close를 과장하지 않고 debt를 분리 기록 |
| v2.7은 release-host와 runtime confidence를 generated evidence로 분리 | full-suite timeout/skip을 숨기지 않고 blocker, accepted debt, deferred scope로 구분해야 했다 | 좋음 - 운영자가 release confidence를 한 곳에서 확인 가능 |
| v2.8은 RealTycoon2 제품 얼굴과 daily work loop를 federation/autonomy/native 확장보다 먼저 닫음 | 사용자가 앱을 켰을 때 Paperclip 잔재나 영문 control-plane 느낌이 보이면 제품 신뢰가 깨진다 | 좋음 - Korean-first board, One-Liner review, support evidence, identity gate가 같은 흐름으로 묶임 |
| v2.9 capture reliability를 v3.0 distribution의 shipped baseline으로 고정 | signing/updater/tray/push 작업 중 DRAFT/NATIVE/MSG/REVIEW를 다시 열면 검증된 입력 루프가 흔들린다 | 진행 중 - v3.0은 regression gate로만 v2.9를 보호 |
| Phase 59에서 Tauri v2 native shell baseline과 `apps/desktop` future package layout을 선택 | 현재 repo는 Vite/PWA-first이고 Tauri가 updater/tray/shortcut/notification/deep-link/mobile-capable boundary를 가장 작게 제공한다 | 좋음 - Phase 60 signing/notarization pipeline이 concrete inventory에서 시작 가능 |
| Phase 60에서 native signing evidence gate를 credential-free script로 구현 | 실제 Apple/Windows credentials와 native artifacts는 release operator evidence이며 repo에는 secret reference와 blocker report contract만 있어야 한다 | 좋음 - Phase 61 updater/channel work가 signing trust signal을 prerequisite로 사용할 수 있음 |
| Phase 61에서 release channel/signed updater evidence gate를 credential-free script로 구현 | internal/beta/stable channel metadata와 updater signatures는 OS signing evidence와 별도이며, rollback/rollout/update state가 없으면 배포 운영이 불가능하다 | 좋음 - Phase 62 tray/global shortcut이 installed channel/build identity와 update state를 상태 표시에 사용할 수 있음 |
| Phase 62에서 resident tray/global shortcut을 native dependency 없이 evidence gate로 닫음 | 실제 Tauri shell 추가 전에도 tray 상태, shortcut lifecycle/privacy, capture review handoff의 release blocker contract를 고정해야 한다 | 좋음 - Phase 64 final distribution gate가 resident surface readiness summary를 소비할 수 있음 |
| Phase 63에서 Mobile/Web Push/APNs loop를 provider 전송 없이 evidence gate로 닫음 | push credential, APNs/Web Push provider availability, native mobile packaging이 없어도 subscription scope, minimal payload, delivery/retry/click/reliability contract는 먼저 고정할 수 있다 | 좋음 - Phase 64 final distribution gate가 push readiness summary를 소비할 수 있음 |
| Phase 64에서 final distribution gate를 summary aggregator로 닫음 | 실제 native artifact와 credential은 operator evidence이며 repo는 release readiness contract와 fail-closed blocker taxonomy를 제공해야 한다 | 좋음 - v3.0 completion truth가 code, docs, requirements, roadmap, verification에서 일치함 |
| v3.1을 DevPlan Core Convergence로 전환 | 개발기획서 대비 방향성은 맞지만 정적 싱크로율이 약 64%이고 Graphify/wikiLLM/Multica engine parity와 핵심 제품 경험이 덜 닫혔다 | 진행 중 - Phase 65에서 alignment truth와 identity boundary를 닫았고 Phase 66에서 cockpit, Phase 67에서 runtime, Phase 68에서 wikiLLM living memory, Phase 69에서 Graphify corpus graph sidecar를 닫았다. Phase 70-71은 economy, acceptance gate를 순서대로 닫음 |
| Graphify를 RT2 product graph와 분리된 corpus graph sidecar로 다룸 | 현재 RT2 graph는 product event projection이고 Graphify v3는 corpus extraction/query engine이므로 같은 것으로 주장하면 completion이 과장된다 | 좋음 - v3.1 Phase 69가 source cache, provenance, connected-components fallback clustering, path/query API, product/corpus 분리 report를 완료했고 DevPlan alignment score를 91%로 올림 |
| Phase 66에서 Mission -> To-Do rollup을 daily cockpit `hierarchyRows`로 노출 | 기존 goal/project/task/deliverable 조각을 새 schema로 재작성하지 않고 API/UI가 같은 evidence contract를 보게 해야 했다 | 좋음 - Daily cockpit과 DevPlan daily rows가 evidence-backed complete로 전환되고 score가 72%가 됨 |

## 다음 마일스톤 목표

v3.4 마일스톤을 시작합니다. 목표는 RT2 Integration & API Alignment입니다.

## Evolution

이 문서는 phase transition과 milestone boundary에서 갱신한다.

**각 phase transition 후** (`$gsd-transition`):
1. 무효화된 요구사항은 이유와 함께 범위 밖으로 이동한다.
2. 검증된 요구사항은 phase reference와 함께 검증 완료로 이동한다.
3. 새 요구사항이 생기면 진행 중에 추가한다.
4. 결정 사항은 주요 결정에 기록한다.
5. "이 프로젝트가 무엇인가"가 현실과 어긋나면 갱신한다.

**각 milestone 후** (`$gsd-complete-milestone`):
1. 전체 섹션을 재검토한다.
2. 핵심 가치가 여전히 우선순위 기준인지 확인한다.
3. 범위 밖 항목의 이유가 여전히 맞는지 감사한다.
4. Context를 현재 상태에 맞게 갱신한다.

---
*마지막 업데이트: 2026-05-04 after v3.5 milestone started*
