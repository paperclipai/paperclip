# v3.1 Requirements: DevPlan Core Convergence

**Milestone:** v3.1 DevPlan Core Convergence
**Status:** active
**Created:** 2026-05-01
**Baseline assessment:** RealTycoon2 개발기획서 대비 정적 싱크로율 약 64%

## Goal

RealTycoon2 개발기획서의 핵심 제품 루프와 Multica/wikiLLM/Graphify 엔진 기준을 실제 코드, UI, 문서, 검증 증거로 다시 정렬한다.

## Requirements

### DevPlan Truth and Traceability

- [ ] **ALIGN-01**: 운영자는 개발기획서 장/핵심 축별로 구현됨, 부분 구현, 미구현, tech debt 상태와 근거 파일을 한 곳에서 확인할 수 있다.
- [ ] **ALIGN-02**: 완료 주장에는 code path, route/schema, UI surface, test/evidence 중 최소 하나 이상의 근거가 연결되고, 근거가 없으면 partial/debt로 표시된다.
- [ ] **ALIGN-03**: milestone close gate는 Graphify, wikiLLM, Multica 수준의 엔진 parity 주장을 근거 없이 `complete`로 표시하지 못하게 막는다.

### RealTycoon2 Identity Cleanup

- [ ] **IDENTITY-01**: 제품 표면 문서, UI copy, onboarding/default state는 RealTycoon2-first Korean identity를 사용하고 Paperclip은 infrastructure/reference로만 설명된다.
- [ ] **IDENTITY-02**: identity regression scan은 UI, docs, server-facing copy에서 product-facing Paperclip/Paper Company/legacy English default copy를 탐지한다.
- [ ] **IDENTITY-03**: `@paperclipai/*`, `PAPERCLIP_*` 같은 호환성 명칭은 public product identity가 아니라 legacy compatibility layer로 문서화된다.

### Daily Work and OKR Cockpit

- [ ] **DAILY-01**: 첫 운영 화면은 개발기획서의 3패널 구조인 왼쪽 OKR tree, 중앙 daily report/board/task mesh, 오른쪽 detail/Jarvis/chat 흐름을 제공한다.
- [ ] **DAILY-02**: One-Liner 입력은 review, Task/To-Do/Deliverable 생성, knowledge projection, economy evidence까지 한 cockpit에서 추적된다.
- [ ] **DAILY-03**: Mission -> Objective -> Key Result -> Project -> Task -> To-Do 계층과 rollup 상태가 API와 UI에서 일관되게 보인다.

### Multica Runtime Alignment

- [ ] **RUNTIME-01**: RT2 execution queue는 Multica-style `queued -> dispatched -> running -> completed/failed/cancelled` 상태 전이와 transition guard를 갖는다.
- [ ] **RUNTIME-02**: agent/runtime claim은 runtime capacity, heartbeat, stale runtime cleanup, cancellation polling을 기준으로 감사 가능한 evidence를 남긴다.
- [ ] **RUNTIME-03**: agent progress, message stream, tool/event output은 work card와 Jarvis evidence surface에서 추적 가능하다.

### wikiLLM Living Memory

- [ ] **WIKI-01**: RT2 event/wiki store는 `index.md`, `log.md`, topic/project/schema page 형태의 wikiLLM-compatible file model로 export 또는 materialize될 수 있다.
- [ ] **WIKI-02**: wiki ingest/update workflow는 provenance, confidence, contradiction flag, related page update evidence를 남긴다.
- [ ] **WIKI-03**: Jarvis grounded answer는 wiki page citation을 제공하고, 가치 있는 답변은 review 가능한 wiki draft/update로 되돌릴 수 있다.

### Graphify v3 Engine Alignment

- [ ] **GRAPH-01**: Graphify sidecar는 repo/docs/wiki source file을 SHA256 file cache와 source location metadata로 증분 ingest한다.
- [ ] **GRAPH-02**: graph build path는 code/docs extraction interface, confidence score, relation provenance를 저장한다.
- [ ] **GRAPH-03**: graph query API는 node, neighbors, community, shortest path, god nodes, graph stats를 제공하고 실제 clustering algorithm 또는 명시된 fallback을 사용한다.
- [ ] **GRAPH-04**: graph report는 RT2 product graph와 corpus graph를 구분하고 knowledge gap, surprising connection, suggested question을 노출한다.

### Economy, Marketplace, and CareerMate Loop

- [ ] **ECON-01**: Marketplace와 P&L은 primary navigation loop에서 접근 가능하며 deliverable price, quality, gold evidence와 연결된다.
- [ ] **ECON-02**: price negotiation, settlement, anti-gaming outcome은 amoeba/user/project P&L rollup에 반영된다.
- [ ] **ECON-03**: CareerMate/avatar/reputation progression은 ledger와 quality evidence를 기반으로 계산되며 placeholder stat으로만 표시되지 않는다.

### v3.1 Acceptance Gate

- [ ] **GATE-01**: v3.1 acceptance gate는 DevPlan alignment, identity, daily cockpit, runtime, wiki/graph, economy loop에 대한 focused tests/scans를 실행한다.
- [ ] **GATE-02**: milestone audit은 64% baseline 대비 score delta, 남은 blocker, accepted debt, future scope를 구체적인 파일 근거와 함께 보고한다.

## Future Requirements

- Public/open company marketplace launch는 trusted company ecosystem 밖의 public rollout 단계에서 다룬다.
- Autonomous Jarvis direct apply는 approval-first contradiction/governance loop가 v3.1 이후 안정화된 뒤 다룬다.
- Native store listing, marketing, reviewer account operations는 v3.0 distribution evidence를 실제 credential/operator 환경에서 채운 뒤 다룬다.
- Cross-company federation full apply는 company boundary, policy, audit model을 별도 milestone에서 다룬다.

## Out of Scope

- backend/data platform greenfield rewrite. 기존 Express, React/Vite, Drizzle, Postgres/PGlite 기반을 보존한다.
- v2.9 capture reliability 재작성. DRAFT/NATIVE/MSG/REVIEW는 regression gate 실패 수정만 허용한다.
- 실제 Apple/Windows signing credential, APNs/Web Push provider secret 저장. repo에는 secret reference와 evidence manifest만 둔다.
- Graphify upstream code를 무비판적으로 vendor-in 하는 방식. RT2 product graph와 corpus graph boundary를 먼저 고정한다.

## Traceability

| Requirement | Phase |
|-------------|-------|
| ALIGN-01 | Phase 65 |
| ALIGN-02 | Phase 65 |
| ALIGN-03 | Phase 65 |
| IDENTITY-01 | Phase 65 |
| IDENTITY-02 | Phase 65 |
| IDENTITY-03 | Phase 65 |
| DAILY-01 | Phase 66 |
| DAILY-02 | Phase 66 |
| DAILY-03 | Phase 66 |
| RUNTIME-01 | Phase 67 |
| RUNTIME-02 | Phase 67 |
| RUNTIME-03 | Phase 67 |
| WIKI-01 | Phase 68 |
| WIKI-02 | Phase 68 |
| WIKI-03 | Phase 68 |
| GRAPH-01 | Phase 69 |
| GRAPH-02 | Phase 69 |
| GRAPH-03 | Phase 69 |
| GRAPH-04 | Phase 69 |
| ECON-01 | Phase 70 |
| ECON-02 | Phase 70 |
| ECON-03 | Phase 70 |
| GATE-01 | Phase 71 |
| GATE-02 | Phase 71 |

---
*마지막 업데이트: 2026-05-01, v3.1 milestone initialized*
