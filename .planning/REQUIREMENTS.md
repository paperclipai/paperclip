# Requirements: RealTycoon2

**Defined:** 2026-05-04
**Core Value:** 회사 범위 work signal은 disconnected tool이나 Paperclip-shaped manual workflow를 강요하지 않고 logging -> execution -> knowledge accumulation -> approval -> economic feedback으로 이어져야 한다.

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Trello Field Extension Parity

- [x] **TRELLO-01**: User can add checklist items to a card and track completion percentage
- [x] **TRELLO-02**: User can set and edit due date with time on a card
- [x] **TRELLO-03**: User can attach colored labels to cards for visual categorization
- [x] **TRELLO-04**: User can assign/remove members to/from a card

### Trello Automation / Power-up Parity (1)

- [x] **POWER-01**: User can create custom fields on a board (text, number, date, dropdown types)
- [x] **POWER-02**: User can view and edit custom field values directly on card
- [x] **POWER-03**: User can use a board calendar view filtered by due date

### Trello Automation / Power-up Parity (2)

- [x] **POWER-04**: User can create formula-based fields on cards (arithmetic, date differences)
- [x] **POWER-05**: User can set board-level card limits per lane (WIP limits)
- [x] **POWER-06**: User can use card templates for quick card creation

## v3.6 Requirements — RT2 Engine Consolidation

**Focus:** Harden event/projector system, improve reliability, fix known issues.

### Event System Reliability

- [ ] **EVENT-01**: Domain events are persisted durably before acknowledgment (at-least-once delivery)
- [ ] **EVENT-02**: Projector replay produces deterministic state from event history
- [ ] **EVENT-03**: Failed projector operations are retried with exponential backoff

### Work Entity Integrity

- [ ] **WORK-01**: Work entity state transitions are atomic and event-sourced
- [ ] **WORK-02**: Stale projector state is detected and auto-repaired
- [ ] **WORK-03**: Work entity count queries are indexed for performance

### Board Performance

- [ ] **PERF-01**: Board overview query loads in < 200ms for 1000 cards
- [ ] **PERF-02**: Custom field values are fetched in single batch query (no N+1)
- [ ] **PERF-03**: Lane card count uses indexed count query, not full scan

### Error Handling & Recovery

- [ ] **RECOV-01**: Failed card operations show retry option with error context
- [ ] **RECOV-02**: Network failure during card edit auto-saves draft locally
- [ ] **RECOV-03**: Server startup validates projector state consistency

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Trello Butler automation (natural language rules) | High complexity, defer to v2+ |
| Card aging power-up | Low priority for v1 |
| Card size power-up | Requires ML/image processing, out of scope |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| TRELLO-01 | Phase 89 | Complete |
| TRELLO-02 | Phase 89 | Complete |
| TRELLO-03 | Phase 89 | Complete |
| TRELLO-04 | Phase 89 | Complete |
| POWER-01 | Phase 90 | Complete |
| POWER-02 | Phase 90 | Complete |
| POWER-03 | Phase 90 | Complete |
| POWER-04 | Phase 91 | Complete |
| POWER-05 | Phase 91 | Complete |
| POWER-06 | Phase 91 | Complete |
| EVENT-01 | Phase 93 | Pending |
| EVENT-02 | Phase 93 | Pending |
| EVENT-03 | Phase 93 | Pending |
| WORK-01 | Phase 94 | Pending |
| WORK-02 | Phase 94 | Pending |
| WORK-03 | Phase 94 | Pending |
| PERF-01 | Phase 95 | Pending |
| PERF-02 | Phase 95 | Pending |
| PERF-03 | Phase 95 | Pending |
| RECOV-01 | Phase 96 | Pending |
| RECOV-02 | Phase 96 | Pending |
| RECOV-03 | Phase 96 | Pending |

**Coverage:**
- v1 + v3.5 requirements: 16 total
- Mapped to phases: 16
- Unmapped: 0 ✓

---
*Requirements defined: 2026-05-04*
*Last updated: 2026-05-05 after v3.5 completion, v3.6 requirements added*
