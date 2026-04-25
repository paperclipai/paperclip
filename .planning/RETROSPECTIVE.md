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

## Cross-Milestone Trend

| Trend | Observation |
|-------|-------------|
| Product identity | RT2가 우선순위다. Paperclip/Multica wording은 product-facing surface에서 숨기고 engine/internal compatibility layer로 제한한다. |
| Verification | Windows sandbox `spawn EPERM`은 반복되는 local environment issue다. Vitest/build에는 승인된 escalated run이 필요할 수 있다. |
| Planning | 사용자는 wave-by-wave prompting보다 긴 `--auto --chain` execution을 선호한다. |
| Milestone scope | v2.1부터 요구사항, phase, summary, archive가 개발기획서 gap map에 직접 연결된다. v2.2부터는 `tech_debt` completion을 명시적으로 기록한다. |
