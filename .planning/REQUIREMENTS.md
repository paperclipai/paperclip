# Requirements: RealTycoon2 Native Distribution Readiness

**Defined:** 2026-04-30
**Core Value:** 회사 범위 work signal은 disconnected tool이나 Paperclip-shaped manual workflow를 강요하지 않고 logging -> execution -> knowledge accumulation -> approval -> economic feedback으로 이어져야 한다.

## v3.0 Requirements

Requirements for `v3.0 Native Distribution Readiness`. v2.9 DRAFT/NATIVE/MSG/REVIEW capture reliability is treated as shipped baseline and may only be touched through regression gates.

### Distribution Pipeline

- [ ] **DIST-01**: 운영자는 native shell packaging 후보와 platform capability 범위를 확인하고, macOS/Windows signing identity, certificate source, entitlement, updater key material을 release evidence로 관리할 수 있다.
- [ ] **DIST-02**: 운영자는 macOS release artifact가 Developer ID signing, hardened runtime, notarization submission, ticket stapling, Gatekeeper verification 상태를 통과했는지 pipeline에서 볼 수 있다.
- [ ] **DIST-03**: 운영자는 Windows MSIX/installer artifact가 Store re-signing, Azure Artifact Signing, OV/EV certificate, timestamping 중 선택된 trust path로 서명되고 install trust evidence를 남기는 것을 확인할 수 있다.
- [ ] **DIST-04**: 운영자는 internal, beta, stable release channel을 분리하고 각 channel의 version, artifact URL, checksum, signature, rollout policy, rollback candidate를 관리할 수 있다.
- [ ] **DIST-05**: 앱은 signed updater feed에서 version, URL, signature, notes metadata를 검증하고 download, install, relaunch, failure state를 운영자에게 보여줄 수 있다.
- [ ] **DIST-06**: release gate는 unsigned, unnotarized, untrusted, timestamp missing, wrong channel, stale updater metadata, v2.9 capture regression failure를 배포 차단 사유로 표시한다.

### Resident Desktop

- [ ] **RES-01**: 운영자는 resident tray/menubar app에서 RealTycoon2 quick capture, sync/queue state, auth/company state, build identity, release channel을 확인할 수 있다.
- [ ] **RES-02**: 운영자는 OS-level global shortcut을 등록, 해제, 변경하고 shortcut conflict, permission, focus/privacy 상태를 확인할 수 있다.
- [ ] **RES-03**: tray/global shortcut capture는 v2.9 persistent draft revision과 board review inbox로만 들어가며 승인 전 자동 apply를 하지 않는다.

### Mobile Push

- [ ] **PUSH-01**: 운영자는 web/mobile/PWA/native device push subscription 또는 APNs/Web Push token을 company, user, device scope로 등록, 해지, rotate할 수 있다.
- [ ] **PUSH-02**: 서버는 approval waiting, failed sync, review requested 같은 RT2 work signal을 최소 payload push로 전달하고 notification click/deep link가 board review target으로 돌아가게 한다.
- [ ] **PUSH-03**: 운영자는 push permission denied, token invalid, delivery failure, retry, click-through metric을 capture reliability report와 release gate evidence에서 확인할 수 있다.

## Future Requirements

### Federation

- **FED-01**: Trusted company 간 read-only federation preview와 sharing contract를 정의한다.
- **FED-02**: Cross-company apply/write는 explicit approval, audit, company boundary policy 이후에만 다룬다.

### Autonomy

- **AUTO-01**: Jarvis autonomous apply는 approval-first observation loop와 provider-backed eval evidence가 안정화된 뒤 다룬다.

### Store Operations

- **STORE-01**: Public App Store, Microsoft Store, Slack/Teams marketplace listing copy, screenshots, legal metadata, reviewer account handling은 distribution pipeline이 green이 된 뒤 별도 store-operations scope로 다룬다.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Reopening v2.9 DRAFT/NATIVE/MSG/REVIEW behavior | v2.9 capture reliability는 shipped baseline이다. 이 milestone에서는 regression gate 실패를 고치는 경우만 허용한다. |
| Cross-company federation full apply | distribution readiness와 company-scoped capture reliability를 먼저 안정화한다. |
| Autonomous Jarvis apply without approval | resident shortcut, tray, push가 입력량을 늘리더라도 approval-first 원칙을 유지한다. |
| Public/open company capture marketplace | iSens Corp. 내부 company-scoped distribution과 push/release 운영이 먼저다. |
| Store listing launch/marketing | 이번 milestone은 signing/updater/notarization/resident/push readiness이며 public store submission 운영은 후속 범위다. |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| DIST-01 | Phase 59 | Pending |
| DIST-02 | Phase 60 | Pending |
| DIST-03 | Phase 60 | Pending |
| DIST-04 | Phase 61 | Pending |
| DIST-05 | Phase 61 | Pending |
| DIST-06 | Phase 64 | Pending |
| RES-01 | Phase 62 | Pending |
| RES-02 | Phase 62 | Pending |
| RES-03 | Phase 62 | Pending |
| PUSH-01 | Phase 63 | Pending |
| PUSH-02 | Phase 63 | Pending |
| PUSH-03 | Phase 63 | Pending |

**Coverage:**
- v3.0 requirements: 12 total
- Mapped to phases: 12
- Unmapped: 0
- Complete: 0
- Pending: 12

---
*Requirements defined: 2026-04-30*
*Last updated: 2026-04-30 after v3.0 milestone initialization*
