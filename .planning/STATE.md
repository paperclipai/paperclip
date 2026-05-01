---
gsd_state_version: 1.0
milestone: v3.1
milestone_name: DevPlan Core Convergence
status: active
last_updated: "2026-05-01T11:45:00+09:00"
last_activity: 2026-05-01 -- Phase 66 completed
progress:
  total_phases: 7
  completed_phases: 2
  total_plans: 2
  completed_plans: 2
  percent: 29
---

# RealTycoon2 Planning State

## Current Position

Phase: 67 (Multica Runtime Execution Alignment)
Plan: -
Status: Phase 66 complete; ready for Phase 67 discussion
Last activity: 2026-05-01 -- Phase 66 completed

## 현재 위치

v3.0 Native Distribution Readiness는 archive됐다. 새 milestone은 **v3.1 DevPlan Core Convergence**다.

이번 milestone은 사용자가 제공한 `RealTycoon2_DevPlan (2).pdf`와 현재 repo의 정적 싱크로율을 약 64%로 재평가한 결과에서 출발한다. 방향성은 맞지만 제품 중심 루프, Paperclip residue 제거, Multica/wikiLLM/Graphify 엔진 충실도, Daily/Marketplace/P&L 핵심 UI의 완결성이 부족하다는 판단을 기준선으로 삼는다.

## 현재 마일스톤

**v3.1 DevPlan Core Convergence**

**Goal:** RealTycoon2 개발기획서의 핵심 제품 루프와 Multica/wikiLLM/Graphify 엔진 기준을 실제 코드, UI, 문서, 검증 증거로 다시 정렬한다.

**Target features:**
- 개발기획서 장/핵심 축별 alignment matrix와 64% baseline score를 evidence-backed 상태로 만든다.
- product-facing Paperclip/Paper Company residue를 제거하고 남는 Paperclip 명칭은 compatibility/reference로 제한한다.
- Daily Work를 PDF의 3패널 cockpit, OKR tree, One-Liner review, Jarvis/detail 흐름으로 수렴시킨다.
- Multica runtime lifecycle을 runtime/capacity/heartbeat/cancellation/evidence 기준으로 강화한다.
- wikiLLM `index.md`/`log.md`/topic/schema page 흐름과 Jarvis citation/update loop를 실제 export/update workflow로 만든다.
- Graphify v3 sidecar 수준의 corpus ingest, cache, provenance, clustering/query/report 기능을 제품 graph와 분리해 구현한다.
- Marketplace, P&L, amoeba economy, CareerMate progression을 deliverable/quality/ledger evidence와 연결한다.

## v3.1 계획

| Phase | Name | Requirements | Status |
|-------|------|--------------|--------|
| 65 | DevPlan Truth and Identity Cleanup | ALIGN-01..03, IDENTITY-01..03 | Complete |
| 66 | Daily Work and OKR Cockpit Convergence | DAILY-01..03 | Complete |
| 67 | Multica Runtime Execution Alignment | RUNTIME-01..03 | Planned |
| 68 | wikiLLM Living Memory Workflow | WIKI-01..03 | Planned |
| 69 | Graphify v3 Corpus Graph Sidecar | GRAPH-01..04 | Planned |
| 70 | Economy, Marketplace, P&L, and CareerMate Loop | ECON-01..03 | Planned |
| 71 | v3.1 DevPlan Acceptance Gate | GATE-01..02 | Planned |

## 누적 맥락

- RealTycoon2가 제품 정체성이다. Paperclip-derived control plane은 infrastructure/reference이며 제품 표면의 주어가 아니다.
- 개발기획서의 핵심은 Paperclip + Multica + wikiLLM/Graphify 삼중 기반, OKR/KPI, 산출물 기반 아메바 경영, Jarvis, 누적 위키/구조 그래프, 게이미피케이션/CareerMate다.
- v3.0은 signed native distribution, updater, resident tray/global shortcut, push notification evidence gates를 완료했지만 PDF의 본체인 제품 경험/엔진 parity를 완전히 닫은 것은 아니다.
- `ENGINE-REFERENCE-AUDIT.md` 기준 Multica는 lifecycle/daemon/queue 차원에서 더 구체화해야 하고, Graphify는 현재 concept-level에 가까워 v3.1에서 dedicated engine alignment가 필요하다.
- v2.9 capture reliability는 shipped baseline으로 보호한다. One-Liner/DRAFT/NATIVE/MSG/REVIEW behavior는 regression failure가 아니면 다시 열지 않는다.
- Phase 66은 Daily Work 3패널 cockpit, One-Liner review/capture evidence, Mission -> To-Do hierarchy rollup, DevPlan alignment 72% evidence를 완료했다.
- Windows sandbox `spawn EPERM`은 계속 환경 제약이다. Vitest/build tooling은 필요 시 host-ready focused command로 검증한다.

## Deferred Items

| Category | Item | Status |
|----------|------|--------|
| federation | Cross-company federation full apply | v3.1 범위 밖 |
| autonomy | Autonomous Jarvis direct apply without approval | v3.1 범위 밖, approval-first 원칙 유지 |
| marketplace | Public/open company marketplace launch | trusted company ecosystem 밖 public rollout 단계로 defer |
| store_ops | Public store listing/marketing/reviewer operations | v3.0 operator evidence 실제 수집 이후 |
| native_credentials | Apple/Windows signing credential, APNs/Web Push secret | repo에 저장하지 않음 |
| capture | v2.9 capture reliability rewrite | regression fix만 허용 |

## 다음 단계

Phase 67 Multica Runtime Execution Alignment를 시작한다.

다음 세션 지시어: `$gsd-discuss-phase 67 --auto --chain`.

---
*상태 업데이트: 2026-05-01, Phase 66 completed*
