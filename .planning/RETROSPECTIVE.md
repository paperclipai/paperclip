# RealTycoon2 회고

## 마일스톤: v2.0 - RT2 Refoundation

**완료:** 2026-04-25  
**Phases:** 7  
**Plans:** 13

### 만든 것

- RT2-first product shell과 navigation.
- deliverable/base-price 구조를 가진 One-Liner work capture.
- task/todo work를 위한 RT2 execution lifecycle record.
- append-only RT2 domain event와 projector tracking.
- cumulative wiki page와 provenance-aware graph projection.
- evidence-backed Jarvis, quality mode, hybrid search.
- ledger-backed P&L, evidence-backed marketplace, derived collaboration reward.

### 잘 된 점

- 계속 진행하기 전에 Windows runtime/worktree failure를 닫아 이후 verification이 안정적이었다.
- Paperclip을 infrastructure로 유지하면서 product truth를 RT2 service로 옮겨 greenfield rewrite를 피했다.
- focused embedded-Postgres test가 매 phase마다 full-suite rerun을 강제하지 않으면서 중요한 service-level behavior를 잡아냈다.
- phase summary가 milestone close 때 유용한 operational memory가 되었다.

### 비효율적이었던 점

- 이전 planning artifact가 completion을 과장해 corrective milestone이 실제 repo truth를 다시 검증하는 데 시간을 써야 했다.
- Phase 2가 너무 많은 verification-gap pass로 쪼개졌다. 앞으로 `--auto --chain` execution은 next step이 명확하면 mechanical cleanup을 inline으로 계속 처리해야 한다.
- 일부 source naming은 아직 inherited Paperclip internal을 반영해 product-state reading을 불필요하게 noisy하게 만든다.

### 확립된 패턴

- RT2 business truth는 RealTycoon2-controlled schema, service, company-scoped API에 둔다.
- mutation은 read model update 전에 event를 append해야 한다.
- Jarvis, quality, search, marketplace, P&L surface는 placeholder-backed가 아니라 evidence-backed여야 한다.
- mechanical cleanup은 full GSD cycle 없이 inline 처리한다.

### 핵심 교훈

- requirement traceability는 milestone close 때 재구성하지 말고 phase close 때 업데이트해야 한다.
- milestone completion은 phase, plan, entire milestone 중 무엇을 닫는지 명시해야 한다.
- completion report는 다음 단계의 정확한 slash command로 끝나야 한다.

## 마일스톤: v2.1 - 개발기획서 반영 및 운영자 채택

**완료:** 2026-04-25  
**Phases:** 6  
**Plans:** 6

### 만든 것

- 개발기획서 alignment checklist와 gap visibility.
- floating, shortcut, voice, messenger-style One-Liner capture.
- daily report cockpit과 OKR/KPI traceability.
- 7-view Task Mesh와 wiki/graph/Obsidian-ready knowledge workspace.
- Jarvis Shadow/Co-Pilot/Auto change-management hardening.
- enterprise rollout setting, portable template preview/apply, binding mode, RT2 terminology cleanup.

### 잘 된 점

- v2.1을 업로드 개발기획서 gap map에 묶어 phase expansion이 ad hoc으로 흐르지 않았다.
- 각 phase가 shared type, server service/API, UI surface, focused test를 함께 닫아 contract drift를 줄였다.
- operator-facing 화면에서 RT2 용어를 강화하고 Paperclip-first label을 줄였다.

### 비효율적이었던 점

- Windows sandbox의 `spawn EPERM`은 Vitest마다 반복되어 승인된 외부 실행이 필요했다.
- 일부 legacy Paperclip package name과 technical import는 아직 남아 있어 product identity 검토 때 noise가 생긴다.
- `.planning`이 git 추적 대상이 아니라 milestone tag/commit workflow를 그대로 적용할 수 없었다.

### 확립된 패턴

- 개발기획서 반영률은 숨은 문서가 아니라 앱 내부 Plan Alignment page로 보여준다.
- capture, daily cockpit, mesh, knowledge, Jarvis, rollout은 따로 떨어진 기능이 아니라 adoption path다.
- irreversible template apply는 create/skip/error preview 객체를 먼저 보여준다.

### 핵심 교훈

- milestone close 전 요구사항 archive와 다음 slash command를 명확히 남겨야 한다.
- `--auto --chain`에서는 확인 질문보다 보수적 기본값으로 계속 진행하는 편이 사용자 기대에 맞다.
- 단순 cleanup은 별도 GSD cycle보다 inline patch와 focused verification이 낫다.

## 마일스톤: v2.2 - 개발기획서 완전 정합성 고도화

**완료:** 2026-04-25  
**Phases:** 5  
**Plans:** 5  
**Audit:** `tech_debt`

### 만든 것

- 일일업무일지 3칸 칸반의 Trello형 drag/drop 이동과 즉시 저장.
- product-facing Paperclip/Multica 노출을 줄인 RealTycoon2 identity shell hardening.
- Trello 기반 RealTycoon2 업무 보드, Task/To-Do 카드, 산출물/가격/OKR badge, 빠른 편집.
- messenger/mobile/native One-Liner inbound draft contract와 검수 route.
- Knowledge Bridge의 vault export/import preview, graph report, evidence status 운영 흐름.
- Marketplace/P&L/enterprise rollout의 계산 근거, 저장값 hydrate, 운영 검수 evidence.

### 잘 된 점

- 사용자의 “Paperclip이 본체처럼 보이면 안 된다”는 판단을 phase scope의 핵심 기준으로 삼아 product surface drift를 줄였다.
- 개발기획서 정합성을 추상 점수가 아니라 UI/API/service/shared type evidence에 연결했다.
- Trello형 보드와 daily report 보드가 실제 작업자가 쓰는 첫 화면에 가까워졌다.

### 비효율적이었던 점

- Phase 14 formal planning artifact가 빠져 있어 milestone audit 중 보강해야 했다.
- Phase 14-18 `VALIDATION.md`가 없어 기능 완료 후에도 Nyquist coverage가 `missing`으로 남았다.
- embedded Postgres host init 제약 때문에 일부 route test는 collected 후 skip되어 strict route-level confidence가 낮다.

### 확립된 패턴

- RealTycoon2 product-facing 표면에서는 upstream project 이름을 숨기고 engine/internal compatibility layer에서만 유지한다.
- 개발기획서 정합성은 `REQUIREMENTS.md`, phase verification, audit report, 앱 내 Plan Alignment evidence가 함께 닫혀야 한다.
- 기능 완료와 검증 산출물 부채는 같은 상태로 뭉개지지 않고 `tech_debt`로 분리 기록한다.

### 핵심 교훈

- 마일스톤 완료 전에 `VALIDATION.md` 생성 여부를 더 일찍 결정해야 한다.
- Trello parity는 drag/drop만으로 끝나지 않는다. checklist, due date, attachment preview, sorting은 사용자가 기대할 수 있는 후속 범위다.
- RealTycoon2 identity hardening은 copy 교체보다 workflow 기본값과 정보 구조 전환이 더 중요하다.

## 마일스톤: v2.3 - 운영 검증 및 외부 연동 실체화

**완료:** 2026-04-27  
**Phases:** 6  
**Plans:** 6  
**Audit:** `tech_debt`

### 만든 것

- Phase 14-18 validation evidence, route fallback test, alignment scorecard 상태를 Phase 19/24 verification에 연결했다.
- SSO provider metadata validation, SCIM sync preview, rollout readiness audit log를 운영자 검수 가능한 enterprise flow로 만들었다.
- Obsidian-compatible vault writer dry-run, import candidate apply, `rt2_wins`/`vault_wins`/`manual_merge` conflict resolution을 추가했다.
- Settlement comment/approve/reject, gold ledger/P&L/audit linkage, anti-gaming signal evidence를 하나의 governance flow로 연결했다.
- Trello advanced checklist, due date, attachment preview, filter/sort, mobile/native capture queue promotion/failure audit을 완성했다.
- Phase 19 `19-VERIFICATION.md` 누락 blocker를 닫고 v2.3 요구사항 17/17을 satisfied로 만들었다.

### 잘 된 점

- 기능 요구사항, phase verification, milestone audit을 분리해 `gaps_found`에서 `tech_debt`까지 상태를 명확히 낮췄다.
- RealTycoon2-controlled storage와 API를 유지하면서 외부 도구 연동을 preview/apply/approval 중심으로 안전하게 확장했다.
- Trello형 보드와 native capture queue가 실제 반복 업무에 필요한 카드 세부 기능까지 도달했다.

### 비효율적이었던 점

- Phase 19 verification artifact가 최초 audit 이후 Phase 24에서 닫혀 한 번 더 gap closure phase가 필요했다.
- Phase 19-24 strict Nyquist `*-VALIDATION.md`를 동시에 만들지는 못해 마일스톤 완료 시 tech debt로 이월했다.
- live IdP handshake, SCIM mutation apply, physical vault daemon 같은 외부 runtime hardening은 여전히 future scope다.

### 확립된 패턴

- 외부 연동은 바로 mutation하지 않고 validation, preview, apply, audit log 단계를 분리한다.
- 경제 보상은 settlement decision, gold ledger, P&L, anti-gaming signal이 함께 닫혀야 한다.
- 마일스톤 audit의 blocker는 별도 gap closure phase로 닫고 재감사 결과를 archive한다.

### 핵심 교훈

- `VERIFICATION.md`와 `VALIDATION.md`의 역할을 phase planning 시점에 구분해야 마일스톤 종료 직전 부채가 줄어든다.
- 기능이 완료되어도 strict validation artifact가 없으면 `passed`가 아니라 `tech_debt`로 기록하는 편이 정확하다.
- v2.4 이후는 새 기능 확장보다 실제 배포/운영 환경 검증과 persistent runtime hardening을 먼저 검토해야 한다.

## 마일스톤: v2.4 - Knowledge+Economy 심화

**완료:** 2026-04-28  
**Phases:** 8  
**Plans:** 10  
**Audit:** initial `gaps_found`, final re-audit `passed`

### 만든 것

- Board/domain event를 daily wiki page, date index, chronological log, per-user page로 project했다.
- Daily wiki output을 confidence-tagged graph, incremental refresh, graph report, community evidence로 연결했다.
- Coin ledger에 atomic `balanceAfter`, debit/credit `leg`, transaction rollback, reconciliation, non-negative balance protection을 추가했다.
- Settlement governance에 duplicate materialization guard, linked ledger evidence, anti-gaming signal, company threshold settings를 추가했다.
- Scheduled, evidence-only wiki consistency linting과 `embedding_consistency` issue type을 추가했다.
- Phase 30-32에서 WIKI/GRAPH/LEDGER/SETTLE/LINT traceability gaps를 닫고 final milestone re-audit을 통과했다.

### 잘 된 점

- 초기 audit failure를 숨기지 않고 Phase 30-32 closure로 분리해 requirements, summary, verification, validation, frontmatter를 명확히 복구했다.
- Knowledge flow와 economy flow를 각각 구현 evidence와 milestone acceptance evidence로 연결했다.
- `pnpm typecheck`와 `pnpm test`가 final gate에서 통과해 milestone close confidence가 이전 tech_debt milestone보다 높아졌다.

### 비효율적이었던 점

- Phase 25-29 기능 완료 후 artifact coverage가 뒤늦게 보강되어 별도 closure phase 3개가 필요했다.
- Initial audit 기준으로 WIKI/GRAPH/LEDGER/SETTLE 요구사항이 orphaned/partial로 보였고, 기능 구현과 milestone acceptance의 간극이 컸다.
- Provider-backed lint와 pgvector semantic search는 아직 future scope라 knowledge 품질 hardening은 다음 milestone에서 다시 판단해야 한다.

### 확립된 패턴

- milestone acceptance는 구현 여부만이 아니라 `REQUIREMENTS.md`, `SUMMARY.md`, `VERIFICATION.md`, `VALIDATION.md`의 traceability로 판정한다.
- Lint는 evidence-only, scheduled, no-auto-fix가 기본 안전 패턴이다.
- Ledger/settlement economy flow는 atomic write, reconciliation, approval evidence, anti-gaming signal을 함께 닫아야 한다.

### 핵심 교훈

- 기능 phase가 끝나는 즉시 summary frontmatter와 verification/validation artifact를 생성해야 closure phase를 줄일 수 있다.
- Initial audit failure는 useful signal이다. 별도 closure phase로 투명하게 닫으면 마일스톤 기록의 신뢰도가 높아진다.
- 다음 milestone은 새 기능보다 provider-backed lint, pgvector readiness, runtime hardening 같은 운영 깊이의 우선순위를 먼저 검토해야 한다.

## 마일스톤: v2.5 - Semantic Knowledge Intelligence

**완료:** 2026-04-29
**Phases:** 6
**Plans:** 6
**Audit:** initial `gaps_found`, final re-audit `passed`

### 만든 것

- Company-scoped semantic index storage, deterministic fallback embedding, incremental reindex status/action을 추가했다.
- Daily wiki, graph evidence, work artifacts, deliverables를 semantic + lexical fallback search로 통합했다.
- Contradiction candidate generation, resolution decisions, activity-log audit, search freshness integration을 추가했다.
- Jarvis answer에 citations, stale evidence warnings, unresolved contradiction warnings, routable citation targets를 연결했다.
- Knowledge operations health route와 dashboard tab으로 semantic index, contradiction review, Jarvis grounding traceability를 gate로 만들었다.
- Phase 38에서 missing verification, validation, summary frontmatter, requirement checkbox/traceability gap을 닫았다.

### 잘 된 점

- v2.4에서 deferred했던 semantic search와 provider-optional contradiction review를 deterministic local baseline 위에 붙여 CI/local dev 안정성을 유지했다.
- Search, contradiction, Jarvis, operations가 같은 RT2 knowledge evidence chain을 공유하도록 연결되어 기능 간 drift가 줄었다.
- Phase 38 closure가 v2.4보다 짧아졌고, artifact gap을 명확히 닫아 milestone re-audit을 `passed`로 만들었다.

### 비효율적이었던 점

- Phase 34-36 verification artifact와 Phase 33-37 validation artifact가 기능 phase 직후 생성되지 않아 여전히 closure phase가 필요했다.
- Local `gsd-sdk query` interface가 현재 runtime과 맞지 않아 formal audit automation을 그대로 실행하지 못하고 file-based closure evidence를 남겨야 했다.
- Live provider-backed embedding/contradiction explanation은 provider-optional storage까지만 닫혀 실제 provider behavior 검증은 다음 hardening 후보로 남았다.

### 확립된 패턴

- Semantic knowledge features는 live provider 없이도 deterministic fallback으로 검증 가능해야 한다.
- Jarvis answer는 citation, warning, target link가 없으면 RT2 knowledge loop의 신뢰 surface로 취급하지 않는다.
- Operations health는 기능 존재 여부가 아니라 index, contradiction, grounding traceability loss를 explicit reason code로 보여줘야 한다.

### 핵심 교훈

- Phase close 시점에 `VERIFICATION.md`, `VALIDATION.md`, summary frontmatter를 함께 생성해야 milestone close가 가벼워진다.
- Provider-backed capability는 optional path와 deterministic baseline을 분리해야 제품 검증과 운영 확장이 동시에 가능하다.
- 다음 milestone은 새 semantic feature보다 connector/runtime/provider/eval hardening 중 하나를 명확히 선택해야 한다.

## 마일스톤: v2.6 - 운영 커넥터 및 자율성 하드닝

**완료:** 2026-04-29  
**Phases:** 5  
**Plans:** 6  
**Audit:** `tech_debt`

### 만든 것

- Enterprise connector apply loop: SSO callback-state evidence, SCIM preview/apply, partial failure, rollback candidate, rollout readiness/activity evidence.
- Trusted local knowledge bridge: pairing, heartbeat, sync queue, last applied, conflict count, blocked reason, Bridge tab health evidence.
- Native/mobile capture hardening: capture source installation/signing evidence, semantic context, duplicate warning, source evidence, promotion metadata, mobile-safe search citations.
- Jarvis autonomy guardrails: proposal-only rewrite workflow, provider/fallback eval rubric, risk/approval evidence, production monitoring signals.
- Validation closure: Phase 19-24 strict validation artifacts, legacy UAT closure, deterministic milestone artifact gate.

### 잘 된 점

- v2.5 semantic loop를 외부 운영 경계로 확장하면서도 deterministic fallback과 approval-first 원칙을 유지했다.
- Phase 43에서 historical validation debt와 current milestone artifact gate를 함께 닫아 다음 milestone close의 누락 탐지가 쉬워졌다.
- `pnpm run rt2:milestone-gate`가 release 전 summary/verification/validation/traceability 누락을 빠르게 잡는 focused gate가 되었다.

### 비효율적이었던 점

- Phase 40-43에서 full `pnpm test`가 Windows host에서 반복 timeout되어 final audit이 `passed`가 아니라 `tech_debt`로 남았다.
- Embedded Postgres suites가 Windows 기본값에서 skip되어 persistence confidence가 fallback/targeted tests 중심으로 남았다.
- Phase 39 `VALIDATION.md` frontmatter가 stale 상태로 남아 artifact metadata와 verification evidence가 완전히 정렬되지 않았다.

### 확립된 패턴

- External connector mutation은 validation/preview/apply/audit evidence를 분리한다.
- Local/native boundary는 source identity, trust pairing, health evidence가 없으면 운영 기능으로 보지 않는다.
- Jarvis autonomous behavior는 direct apply가 아니라 proposal, eval, approval, monitoring으로만 확장한다.
- Milestone gate는 artifact completeness를 증명하고 runtime confidence는 별도 verification evidence로 기록한다.

### 핵심 교훈

- Full-suite timeout은 completion blocker와 tech debt를 분리해 기록해야 한다. Targeted evidence가 충분해도 release-host verification은 별도 debt다.
- Legacy UAT closure artifact가 있어도 audit-open tooling이 unknown으로 보는 파일은 close 시점에 명시적으로 acknowledged/deferred 기록이 필요하다.
- Validation metadata는 phase completion 직후 업데이트해야 final audit에서 실제 evidence와 형식 상태가 어긋나지 않는다.

## Cross-Milestone Trend

| Trend | Observation |
|-------|-------------|
| Product identity | RT2가 우선순위다. Paperclip/Multica wording은 product-facing surface에서 숨기고 engine/internal compatibility layer로 제한한다. |
| Verification | Windows sandbox `spawn EPERM`은 반복되는 local environment issue다. Vitest/build에는 승인된 escalated run이 필요할 수 있다. |
| Planning | 사용자는 wave-by-wave prompting보다 긴 `--auto --chain` execution을 선호한다. |
| Milestone scope | v2.1부터 요구사항, phase, summary, archive가 개발기획서 gap map에 직접 연결된다. v2.2부터는 `tech_debt` completion을 명시적으로 기록하고, v2.3부터는 gap closure phase와 재감사 archive까지 포함한다. v2.4부터는 initial audit failure를 closure phase로 닫고 final re-audit `passed`까지 기록한다. v2.5는 semantic knowledge loop를 기능 phase 5개와 closure phase 1개로 닫았다. v2.6은 운영 hardening을 완료하되 full-suite timeout을 `tech_debt`로 분리했다. |
