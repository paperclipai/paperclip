# Requirements: RealTycoon2 v2.3

**Defined:** 2026-04-25  
**Milestone:** v2.3 운영 검증 및 외부 연동 실체화  
**Core Value:** 회사 범위 work signal은 disconnected tool이나 Paperclip-shaped manual workflow를 강요하지 않고 logging -> execution -> knowledge accumulation -> approval -> economic feedback으로 이어져야 한다.

## v2.3 Requirements

v2.3은 v2.2에서 `tech_debt`로 인정한 검증 산출물과 개발기획서 remaining 6% gap을 실제 운영 가능한 깊이로 닫는다.

### 검증 및 안정화

- [x] **VALID-01**: 운영자는 Phase 14-18 각각의 `VALIDATION.md`에서 요구사항, 구현 증거, 검증 명령, 잔여 리스크를 확인할 수 있다.
- [x] **VALID-02**: 개발자는 embedded Postgres host init 제약으로 skip된 Phase 17-18 route suite를 실행 가능한 fixture 또는 fallback으로 검증할 수 있다.
- [x] **VALID-03**: 운영자는 v2.2 alignment scorecard에서 `tech_debt`, `validated`, `deferred` 상태가 실제 검증 산출물과 동기화된 것을 볼 수 있다.

### Enterprise Rollout

- [ ] **ENT-02**: 운영자는 SSO provider metadata를 업로드하거나 입력하고 issuer, SSO URL, certificate 만료, callback 설정의 유효성을 검증할 수 있다.
- [ ] **ENT-03**: 운영자는 SCIM user/group sync preview를 실행하고 생성/수정/비활성화 대상과 위험 경고를 적용 전에 확인할 수 있다.
- [ ] **ENT-04**: 운영자는 rollout readiness 화면에서 SSO, SCIM, binding mode, policy default의 실제 검증 결과와 감사 로그를 한 번에 확인할 수 있다.

### Knowledge Bridge

- [ ] **KNOW-02**: 운영자는 Obsidian-compatible local vault writer 설정을 저장하고 export 대상 경로, dry-run 결과, 파일 충돌 위험을 확인할 수 있다.
- [ ] **KNOW-03**: 운영자는 vault import preview를 실제 wiki page, graph node, graph edge 변경 후보로 검토하고 승인된 변경만 반영할 수 있다.
- [ ] **KNOW-04**: 운영자는 bidirectional sync conflict를 `RT2 wins`, `Vault wins`, `manual merge` 중 하나로 해결하고 결정 근거를 감사 기록으로 남길 수 있다.

### Economy and Governance

- [ ] **ECON-02**: 작업자는 산출물 가격 제안, 근거, 협상 코멘트, 승인 상태를 하나의 settlement flow에서 볼 수 있다.
- [ ] **ECON-03**: 승인자는 고가 산출물 settlement를 승인/반려하고 gold ledger, P&L, audit log 반영 결과를 확인할 수 있다.
- [ ] **ECON-04**: 운영자는 반복 self-review, 비정상 gold farming, 품질 점수 편향 같은 anti-gaming signal을 확인하고 settlement에 반영할 수 있다.

### Work Board and Capture

- [ ] **TRELLO-03**: 사용자는 RealTycoon2 업무 카드에서 checklist를 추가, 완료, 재정렬하고 진행률이 카드와 상세 패널에 반영되는 것을 볼 수 있다.
- [ ] **TRELLO-04**: 사용자는 카드 due date, priority, assignee, attachment preview를 설정하고 board에서 필터/정렬할 수 있다.
- [ ] **TRELLO-05**: 사용자는 lane, 담당자, OKR, due date, 가격, 품질 상태 기준으로 board를 필터링하고 정렬할 수 있다.
- [ ] **CAPTURE-02**: 사용자는 mobile/native capture entry가 실제 inbound draft queue에 들어오고 review 후 Task/To-Do/Deliverable로 승격되는 것을 확인할 수 있다.
- [ ] **CAPTURE-03**: 운영자는 messenger/mobile/native capture source별 실패, 중복, 권한 문제를 감사 가능한 상태로 추적할 수 있다.

## Future Requirements

### Public Ecosystem

- **ECO-05**: 회사 외부 사용자까지 포함하는 public marketplace를 운영할 수 있다.
- **MOB-04**: app-store 배포 수준의 native mobile app을 제공할 수 있다.
- **AI-OPS-05**: Jarvis Auto mode가 승인된 예산 안에서 외부 provider workflow를 end-to-end로 실행할 수 있다.

## Out of Scope

| Feature | Reason |
|---------|--------|
| 전체 backend/data platform rewrite | v2.3 목표는 남은 gap의 운영 깊이 보강이며, 기존 Express/Drizzle/Postgres 기반 RT2 truth를 보존한다. |
| Paperclip/Multica 내부 package 전면 rename | product-facing 정체성은 이미 RT2로 고정했고, 내부 compatibility layer rename은 기능 가치 대비 위험이 크다. |
| public marketplace launch | 신뢰된 회사 내부 운영과 settlement governance 안정화가 먼저다. |
| store-distributed native app | v2.3은 inbound queue와 검수 가능한 capture flow를 우선 닫는다. |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| VALID-01 | Phase 19 | Complete |
| VALID-02 | Phase 19 | Complete |
| VALID-03 | Phase 19 | Complete |
| ENT-02 | Phase 20 | Pending |
| ENT-03 | Phase 20 | Pending |
| ENT-04 | Phase 20 | Pending |
| KNOW-02 | Phase 21 | Pending |
| KNOW-03 | Phase 21 | Pending |
| KNOW-04 | Phase 21 | Pending |
| ECON-02 | Phase 22 | Pending |
| ECON-03 | Phase 22 | Pending |
| ECON-04 | Phase 22 | Pending |
| TRELLO-03 | Phase 23 | Pending |
| TRELLO-04 | Phase 23 | Pending |
| TRELLO-05 | Phase 23 | Pending |
| CAPTURE-02 | Phase 23 | Pending |
| CAPTURE-03 | Phase 23 | Pending |

**Coverage:**
- v2.3 requirements: 17 total
- Mapped to phases: 17
- Unmapped: 0

---
*Requirements defined: 2026-04-25*
*Last updated: 2026-04-25 after v2.3 milestone initialization*
