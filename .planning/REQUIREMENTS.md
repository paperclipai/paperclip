# v3.2 Requirements: Future Scope

**Milestone:** v3.2 Future Scope
**Status:** planning
**Created:** 2026-05-01

## Goal

RealTycoon2를 trusted internal company evidence ecosystem에서 public/open marketplace, cross-company federation, billing/payroll settlement, public store operations 영역으로 확장한다.

## Requirements

### Public Marketplace Launch

- [ ] **MKT-01**: Public/open marketplace는 company-scoped evidence ecosystem 외부에서도 discoverable하고 settlement/ledger/CareerMate evidence가 visible하다.
- [ ] **MKT-02**: Public listing은 approval workflow를 거치며 trusted company boundary 밖에서도 quality/price/reputation evidence가 온전하다.
- [ ] **MKT-03**: Marketplace search/discovery는 public metadata와 private evidence contract를 분리하여 운영한다.

### Billing, Payroll, and Settlement

- [ ] **BILL-01**: Settlement는 approved deliverable 기반 automatic payment processing으로 확장되어 approved 상태에서 ledger transaction이 발생한다.
- [ ] **BILL-02**: Payroll processing은 agent/operator gold balance에서 monthly payroll deduction/credit 루프를 실행한다.
- [ ] **BILL-03**: Payment settlement evidence는 bank/payment provider integration receipt와 reconcile 가능하다.

### Federation and Cross-Company Evidence

- [ ] **FED-01**: Cross-company federation은 company boundary, policy, audit model을跨越하는 evidence sharing contract를 갖는다.
- [ ] **FED-02**: Federation partner company의 evidence는 local company scope와 분리되어 audit trail이 company 별로 유지된다.

### Autonomous Jarvis Direct Apply

- [ ] **AUTO-01**: Autonomous Jarvis direct apply는 approval-first governance boundary를 유지하면서 eval-backed proposal이 직접 적용되는 루프를 갖는다.
- [ ] **AUTO-02**: Direct apply risk evaluation은 rubric-based scoring과 operator review approval gate를 거친다.

### Public Store Operations

- [ ] **STORE-01**: Public store listing/operations는 App Store/Google Play/metastore presence에 대한 metadata management evidence를 갖는다.
- [ ] **STORE-02**: Store reviewer communication과 status tracking이 company-scoped audit trail로 관리된다.

### v3.2 Acceptance Gate

- [ ] **GATE-01**: v3.2 acceptance gate는 public marketplace, billing/payroll, federation, autonomous Jarvis, store operations에 대한 focused tests/scans를 실행한다.
- [ ] **GATE-02**: milestone audit은 v3.1 baseline 대비 개선 evidence와 남은 blocker, accepted debt, future scope를 구체적인 파일 근거와 함께 보고한다.

## Future Requirements

- Real-time payment provider webhook integration은 payment receipt validation 후 처리한다.
- Mandatory provider-only eval path는 autonomous Jarvis direct apply 안정화 후 별도 phase로 다룬다.

## Out of Scope

- Backend/data platform greenfield rewrite. 기존 Express, React/Vite, Drizzle, Postgres/PGlite 기반을 보존한다.
- v2.9 capture reliability 재작성. DRAFT/NATIVE/MSG/REVIEW는 regression gate 실패 수정만 허용한다.
- 실제 Apple/Windows signing credential, APNs/Web Push provider secret 저장. repo에는 secret reference와 evidence manifest만 둔다.
- Graphify upstream code를 무비판적으로 vendor-in 하는 방식. RT2 product graph와 corpus graph boundary는 v3.1에서 고정됨.

## Traceability

| Requirement | Phase |
|-------------|-------|
| MKT-01 | Phase 72 |
| MKT-02 | Phase 72 |
| MKT-03 | Phase 72 |
| BILL-01 | Phase 73 |
| BILL-02 | Phase 73 |
| BILL-03 | Phase 73 |
| FED-01 | Phase 74 |
| FED-02 | Phase 74 |
| AUTO-01 | Phase 75 |
| AUTO-02 | Phase 75 |
| STORE-01 | Phase 76 |
| STORE-02 | Phase 76 |
| GATE-01 | Phase 77 |
| GATE-02 | Phase 77 |

---
*마지막 업데이트: 2026-05-01, v3.2 started*