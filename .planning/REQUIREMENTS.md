# Requirements: RealTycoon2

**Defined:** 2026-05-04
**Milestone:** v3.4 RT2 Integration & API Alignment
**Core Value:** 회사 범위 work signal은 disconnected tool이나 Paperclip-shaped manual workflow를 강요하지 않고 logging -> execution -> knowledge accumulation -> approval -> economic feedback으로 이어져야 한다.

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### RT2 Event/Projector Layer

- [x] **RT2-01**: RT2 event stream이 append-only projection pattern을 따르고 replay-safe projector state를 유지한다.
- [x] **RT2-02**: RT2 execution lifecycle event가 Multica runtime과 integrated되어 dispatch/heartbeat/cancel evidence를 갖는다.
- [x] **RT2-03**: Work/Task/Deliverable lifecycle이 RT2-native operation contract를 따르고 Paperclip legacy pattern이 없다.

### API Contract Alignment

- [x] **API-01**: REST/WebSocket API contract가 RT2-native operation contract를 따른다.
- [ ] **API-02**: API versioning strategy가 semantic versioning, breaking change policy, deprecation timeline을 정의한다.
- [ ] **API-03**: API backward compatibility가 보장되며 migration path가 문서화되어 있다.

### Work Entity Migration

- [ ] **WORK-01**: Work entity lifecycle이 event/projector 기반으로 event modeling 및 schema 정의가 완료되었다.
- [ ] **WORK-02**: Task/Deliverable entity가 Work entity와 integrated되어 lifecycle state가 정확히 추적된다.
- [ ] **WORK-03**: Work entity migration이 기존 데이터를 보존하며 migration script가 검증되었다.

### RT2 Schema Validation

- [ ] **SCHEMA-01**: RT2 product entity와 DB schema간 정합성이 검증되었다.
- [ ] **SCHEMA-02**: Schema migration이 versioned되어 rollback 가능한 구조를 갖는다.
- [ ] **SCHEMA-03**: Schema validation test가 존재하고 CI/CD에서 실행된다.

### v3.4 Acceptance Gate

- [ ] **GATE-01**: RT2 Event/Projector Layer verification이 100% coverage를 달성한다.
- [ ] **GATE-02**: API contract alignment가 backward compatibility test를 통과한다.
- [ ] **GATE-03**: Work entity migration이 기존 데이터를 보존하며 validation을 통과한다.
- [ ] **GATE-04**: milestone audit은 모든 evidence를 파일 기반으로 보고한다.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Backend/data platform greenfield rewrite | 기존 Express, React/Vite, Drizzle, Postgres/PGlite 기반을 보존한다 |
| v3.2에서 완료한 public marketplace, billing/payroll, federation, autonomous Jarvis, store operations | 건드리지 않음 |
| Paperclip infrastructure/reference asset 재개발 | 본래 목적(infra/reference)으로만 사용, product-facing 제거가 목표 |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| RT2-01 | Phase 84 | Complete |
| RT2-02 | Phase 84 | Complete |
| RT2-03 | Phase 84 | Complete |
| API-01 | Phase 85 | Pending |
| API-02 | Phase 86 | Pending |
| API-03 | Phase 86 | Pending |
| WORK-01 | Phase 87 | Pending |
| WORK-02 | Phase 87 | Pending |
| WORK-03 | Phase 87 | Pending |
| SCHEMA-01 | Phase 88 | Pending |
| SCHEMA-02 | Phase 88 | Pending |
| SCHEMA-03 | Phase 88 | Pending |
| GATE-01 | Phase 89 | Pending |
| GATE-02 | Phase 89 | Pending |
| GATE-03 | Phase 89 | Pending |
| GATE-04 | Phase 89 | Pending |

**Coverage:**
- v1 requirements: 16 total
- Mapped to phases: 16
- Unmapped: 0 ✓

---
*Requirements defined: 2026-05-04*
*Last updated: 2026-05-04 after v3.4 started*