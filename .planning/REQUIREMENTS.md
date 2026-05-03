# v3.3 Requirements: RT2 Engine Convergence

**Milestone:** v3.3 RT2 Engine Convergence
**Status:** planning
**Created:** 2026-05-04

## Goal

RT2/Multica/wikiLLM+Graphify 삼중 기반 로직이 앱에 정확히 반영되어 RealTycoon2 운영엔진으로 동작하는지 확인하고 개선한다. 혹시나 아직 Paperclip 방식으로 동작하는 부분이 있으면 전면 개편한다.

## Requirements

### Multica Runtime Alignment

- [ ] **MULTICA-01**: RT2 execution lifecycle에서 Multica queue/claim/heartbeat/dispatch 루프가 정확히 동작한다.
- [ ] **MULTICA-02**: Multica runtime capacity, stale task cleanup, progress stream이 RT2 work card와 Jarvis surface에서 추적 가능하다.
- [ ] **MULTICA-03**: Multica runtime event/projector integration이 event stream과 올바르게 연결되어 있다.

### RT2 Event/Projector Alignment

- [ ] **RT2-01**: RT2 event stream이 append-only projection pattern을 따르고 replay-safe projector state를 유지한다.
- [ ] **RT2-02**: RT2 execution lifecycle event가 Multica runtime과 integrated되어 dispatch/heartbeat/cancel evidence를 갖는다.
- [ ] **RT2-03**: Work/Task/Deliverable lifecycle이 RT2-native operation contract를 따르고 Paperclip legacy pattern이 없다.

### wikiLLM/Graphify Knowledge Projection

- [ ] **WIKI-01**: wikiLLM `index.md`/`log.md`/topic/project/schema page export/update가 RT2 event store와 연결되어 있다.
- [ ] **WIKI-02**: Graphify v3 corpus graph sidecar가 RT2 product graph와 분리되어 source cache, provenance, clustering을 갖는다.
- [ ] **WIKI-03**: RT2 knowledge projection이 RT2-native operation으로 동작하고 Paperclip residue가 없다.

### Paperclip Residue Cleanup

- [ ] **CLEANUP-01**: RT2 product-facing surface에서 Paperclip-derived control plane naming이 완전히 제거되었다.
- [ ] **CLEANUP-02**: RT2 schema/service/API projection이 RT2-controlled contract만 사용하고 upstream Paperclip asset을 직접 참조하지 않는다.
- [ ] **CLEANUP-03**: UI surface에서 `@paperclipai/*` package 참조가 compatibility layer로만 존재하고 product-facing이 아니다.

### v3.3 Acceptance Gate

- [ ] **GATE-01**: RT2/Multica/wikiLLM/Graphify integration verification이 100% coverage를 달성한다.
- [ ] **GATE-02**: milestone audit은 RT2-native operation 증거와 Paperclip residue 없음 증거를 파일 기반으로 보고한다.

## Out of Scope

- Backend/data platform greenfield rewrite. 기존 Express, React/Vite, Drizzle, Postgres/PGlite 기반을 보존한다.
- v3.2에서 완료한 public marketplace, billing/payroll, federation, autonomous Jarvis, store operations는 건드리지 않는다.
- Paperclip infrastructure/reference asset은 본래 목적(infra/reference)으로만 사용한다. product-facing 제거가 목표다.

## Traceability

| Requirement | Phase |
|-------------|-------|
| MULTICA-01 | Phase 78 |
| MULTICA-02 | Phase 78 |
| MULTICA-03 | Phase 79 |
| RT2-01 | Phase 80 |
| RT2-02 | Phase 80 |
| RT2-03 | Phase 81 |
| WIKI-01 | Phase 82 |
| WIKI-02 | Phase 82 |
| WIKI-03 | Phase 82 |
| CLEANUP-01 | Phase 83 |
| CLEANUP-02 | Phase 83 |
| CLEANUP-03 | Phase 83 |
| GATE-01 | Phase 84 |
| GATE-02 | Phase 84 |

---
*마지막 업데이트: 2026-05-04, v3.3 started*