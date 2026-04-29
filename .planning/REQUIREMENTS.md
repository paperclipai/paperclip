# Requirements: RealTycoon2 v2.6 운영 커넥터 및 자율성 하드닝

**Defined:** 2026-04-29
**Core Value:** 회사 범위 work signal은 disconnected tool이나 Paperclip-shaped manual workflow를 강요하지 않고 logging -> execution -> knowledge accumulation -> approval -> economic feedback으로 이어져야 한다.

## v2.6 Requirements

### External Connectors

- [x] **EXT-01**: 운영자는 IdP OIDC/SAML handshake를 실제 metadata, callback state, 실패 사유, audit evidence와 함께 검증할 수 있다.
- [x] **EXT-02**: 운영자는 SCIM user/group 변경을 preview에서 apply로 승격하고, 적용 결과와 rollback candidate를 activity log에서 확인할 수 있다.
- [ ] **EXT-03**: 운영자는 trusted local Obsidian bridge/daemon을 pairing하고 vault sync health, queue, conflict, last applied evidence를 확인할 수 있다.

### Native and Mobile Capture

- [ ] **CAP-01**: 운영자는 Slack/Teams/native capture source 설치 상태와 signed inbound source identity를 검수할 수 있다.
- [ ] **CAP-02**: 사용자는 mobile/native inbound draft를 semantic context, duplicate warning, source evidence와 함께 review queue에서 promotion할 수 있다.
- [ ] **CAP-03**: 사용자는 mobile-sized knowledge search surface에서 semantic result, lexical fallback, citation target, unresolved contradiction warning을 확인할 수 있다.

### Autonomy and Evals

- [ ] **AUTO-01**: Jarvis는 knowledge rewrite를 직접 적용하지 않고 evidence, risk, expected diff, approval route가 포함된 proposed change로만 제출할 수 있다.
- [ ] **AUTO-02**: 운영자는 provider-backed evaluation과 deterministic fallback evaluation을 같은 rubric으로 실행하고 결과 차이를 비교할 수 있다.
- [ ] **AUTO-03**: 운영자는 Jarvis grounding, rewrite proposal, citation freshness, contradiction warning 품질을 production monitoring dashboard에서 추적할 수 있다.

### Validation Closure

- [ ] **VAL-01**: Phase 19-24의 strict `*-VALIDATION.md` debt는 현재 code behavior와 test evidence를 기준으로 재검증되어 archive 상태와 연결된다.
- [ ] **VAL-02**: legacy `Phase 01 / 01-UAT.md`와 `m1-6-daily-report / m1-6-UAT.md` unknown 항목은 재분류, 종료 근거, 또는 명시적 future scope로 정리된다.
- [ ] **VAL-03**: milestone health gate는 `SUMMARY.md`, `VERIFICATION.md`, `VALIDATION.md`, requirements checkbox, traceability frontmatter 누락을 release 전에 탐지한다.

## Future Requirements

### Federation

- **FED-01**: Trusted company ecosystem 안에서 cross-company knowledge federation을 preview한다.

### Native Distribution

- **NATIVE-01**: App-store style native mobile distribution과 device-level push notification을 운영한다.

### Full Autonomy

- **AUTO-04**: Jarvis가 승인 없이 low-risk knowledge maintenance를 자동 적용한다.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Public/open marketplace connectors | trusted company ecosystem 밖이며 v2.6의 audit boundary를 흐린다 |
| Mandatory live provider dependency | local dev와 CI는 deterministic fallback으로 검증 가능해야 한다 |
| Approval 없는 autonomous knowledge rewrite | contradiction review와 eval loop가 먼저 충분히 관찰되어야 한다 |
| Full native app distribution | capture/install hardening이 먼저이며 app-store 배포는 별도 milestone 범위다 |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| EXT-01 | Phase 39 | Complete |
| EXT-02 | Phase 39 | Complete |
| EXT-03 | Phase 40 | Pending |
| CAP-01 | Phase 41 | Pending |
| CAP-02 | Phase 41 | Pending |
| CAP-03 | Phase 41 | Pending |
| AUTO-01 | Phase 42 | Pending |
| AUTO-02 | Phase 42 | Pending |
| AUTO-03 | Phase 42 | Pending |
| VAL-01 | Phase 43 | Pending |
| VAL-02 | Phase 43 | Pending |
| VAL-03 | Phase 43 | Pending |

**Coverage:**
- v2.6 requirements: 12 total
- Mapped to phases: 12
- Unmapped: 0

---
*Requirements defined: 2026-04-29*
*Last updated: 2026-04-29 after Phase 39 completion*
