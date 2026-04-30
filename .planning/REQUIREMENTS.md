# Requirements: RealTycoon2 Native Capture and Draft Reliability

**Defined:** 2026-04-30
**Core Value:** 회사 범위 work signal은 disconnected tool이나 Paperclip-shaped manual workflow를 강요하지 않고 logging -> execution -> knowledge accumulation -> approval -> economic feedback으로 이어져야 한다.

## v2.9 Requirements

### Draft Reliability

- [ ] **DRAFT-01**: 운영자는 One-Liner, mobile/native, Slack/Teams inbound draft를 보드 검수 전후에 저장된 draft record로 다시 열 수 있다.
- [ ] **DRAFT-02**: 운영자는 draft의 제목, 업무 유형, 산출물 후보, 가격/품질 힌트, OKR/KPI 후보, source evidence를 승인 전 수정할 수 있다.
- [ ] **DRAFT-03**: 운영자는 draft 수정 이력, 원본 입력, source, duplicate warning, 실패 사유를 audit 가능한 형태로 확인할 수 있다.
- [ ] **DRAFT-04**: 운영자는 수정된 draft를 승인, 반려, 보류, 재검토 요청 상태로 전환하고 보드 inbox/lane 상태가 일관되게 유지되는 것을 볼 수 있다.

### Native Quick Capture

- [ ] **NATIVE-01**: 운영자는 web app 밖에서도 tray/PWA/mobile-friendly quick capture entry에서 One-Liner를 빠르게 남길 수 있다.
- [ ] **NATIVE-02**: 운영자는 native/mobile quick capture가 offline 또는 server unavailable 상태에서도 local queue와 retry 상태를 표시하는 것을 볼 수 있다.
- [ ] **NATIVE-03**: 운영자는 capture entry가 현재 company/workspace 연결 상태, 인증 상태, 마지막 sync 결과를 명확히 보여주는 것을 확인할 수 있다.

### Messaging Capture

- [x] **MSG-01**: 운영자는 Slack/Teams/webhook capture source를 설치 또는 연결하는 설정 흐름에서 signing secret, callback URL, source label, health status를 확인할 수 있다.
- [x] **MSG-02**: 운영자는 messaging inbound draft가 같은 draft revision/review flow에 들어오며 source-specific metadata와 permission failure를 보존하는 것을 볼 수 있다.
- [x] **MSG-03**: 운영자는 duplicate, unauthorized source, malformed payload 같은 messaging capture 실패를 board review surface와 audit evidence에서 구분할 수 있다.

### Review Operations

- [ ] **REVIEW-01**: 운영자는 board review inbox에서 source, status, duplicate, failed sync, approval waiting, revised draft 기준으로 capture draft를 필터링할 수 있다.
- [ ] **REVIEW-02**: 운영자는 draft promotion 후 생성된 Task/To-Do/Deliverable과 원본 draft evidence 사이를 왕복 탐색할 수 있다.
- [ ] **REVIEW-03**: 운영자는 capture reliability report에서 source별 draft count, failure count, retry count, promotion latency를 확인할 수 있다.

## Future Requirements

### Native Distribution

- **DIST-01**: App-store 수준 signing, updater, release channel, installer notarization pipeline을 제공한다.
- **DIST-02**: OS-level global shortcut, menubar/tray resident app, mobile push notification을 production distribution 수준으로 제공한다.

### Federation

- **FED-01**: Trusted company 간 read-only federation preview와 sharing contract를 정의한다.
- **FED-02**: Cross-company apply/write는 explicit approval, audit, company boundary policy 이후에만 다룬다.

### Autonomy

- **AUTO-01**: Jarvis autonomous apply는 approval-first observation loop와 provider-backed eval evidence가 안정화된 뒤 다룬다.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Full app-store native distribution | 이번 milestone은 capture reliability와 lightweight native/mobile entry를 검증하는 단계이며 signing/updater/store는 별도 위험을 가진다 |
| Cross-company federation full apply | capture reliability와 local/company-scoped input loop가 먼저 안정화되어야 한다 |
| Autonomous Jarvis apply without approval | 입력/검수 신뢰를 해치지 않도록 approval-first 원칙을 유지한다 |
| Public marketplace/open company capture | iSens Corp. 내부 company-scoped capture loop가 먼저 안정화되어야 한다 |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| DRAFT-01 | Phase 54 | Pending |
| DRAFT-02 | Phase 54 | Pending |
| DRAFT-03 | Phase 54 | Pending |
| DRAFT-04 | Phase 54 | Pending |
| NATIVE-01 | Phase 55 | Pending |
| NATIVE-02 | Phase 55 | Pending |
| NATIVE-03 | Phase 55 | Pending |
| MSG-01 | Phase 56 | Complete |
| MSG-02 | Phase 56 | Complete |
| MSG-03 | Phase 56 | Complete |
| REVIEW-01 | Phase 57 | Pending |
| REVIEW-02 | Phase 57 | Pending |
| REVIEW-03 | Phase 57 | Pending |

**Coverage:**
- v2.9 requirements: 13 total
- Mapped to phases: 13
- Unmapped: 0

---
*Requirements defined: 2026-04-30*
*Last updated: 2026-04-30 after Phase 56 completion*
