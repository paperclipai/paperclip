# Requirements: RealTycoon2 v2.7

**Defined:** 2026-04-29
**Milestone:** v2.7 릴리즈 호스트 검증 및 런타임 신뢰도
**Core Value:** 회사 범위 work signal은 disconnected tool이나 Paperclip-shaped manual workflow를 강요하지 않고 logging -> execution -> knowledge accumulation -> approval -> economic feedback으로 이어져야 한다.

## v2.7 Requirements

### Release Verification

- [ ] **REL-01**: Operator can run a documented release-host verification command that executes `pnpm typecheck` and `pnpm test` with stable timeout handling.
- [ ] **REL-02**: Operator can inspect failed or timed-out release-host verification runs with phase, suite, duration, and owner classification.
- [ ] **REL-03**: Operator can rerun only the failed release verification slice without losing the full-suite audit trail.

### Embedded Postgres

- [ ] **PG-01**: Operator can run RT2 embedded Postgres persistence tests on Windows through a host-ready path instead of silent default skip.
- [ ] **PG-02**: Operator can see why any embedded Postgres suite was skipped, including host capability, env flag, and fallback evidence.
- [ ] **PG-03**: Operator can verify route-level persistence flows that previously depended on embedded Postgres skip behavior.

### Artifact Integrity

- [ ] **ART-01**: Operator can run a milestone artifact gate that rejects stale phase validation frontmatter when execution evidence says complete.
- [ ] **ART-02**: Operator can see one consistent closure status for legacy UAT files across phase artifacts, audit-open tooling, and milestone audit docs.
- [ ] **ART-03**: Operator can trace each v2.7 requirement to exactly one phase and one verification artifact before milestone close.

### Runtime Confidence

- [ ] **CONF-01**: Operator can view current release confidence status, accepted debt, and verification evidence from a single RT2 operations surface or generated report.
- [ ] **CONF-02**: Operator can distinguish blocker, accepted tech debt, and deferred future scope in release confidence output.

## Future Requirements

### Native Distribution

- **NATIVE-01**: Operator can distribute signed native/mobile capture clients outside local development.

### Federation

- **FED-01**: Trusted company ecosystem can opt into cross-company knowledge federation with explicit approval boundaries.

### Provider Evals

- **EVAL-01**: Jarvis autonomy evaluation can require live provider-backed scoring in production while preserving deterministic fallback for CI/local development.

## Out of Scope

| Feature | Reason |
|---------|--------|
| New Jarvis autonomous apply behavior | v2.7 is confidence hardening; direct apply remains approval-first future scope |
| Cross-company knowledge federation | Outside trusted single-company confidence gate for this milestone |
| Native app-store distribution | Requires release confidence foundation first |
| Mandatory live provider dependency in CI | Deterministic fallback remains required for local and CI stability |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| REL-01 | Phase 44 | Pending |
| REL-02 | Phase 44 | Pending |
| REL-03 | Phase 44 | Pending |
| PG-01 | Phase 45 | Pending |
| PG-02 | Phase 45 | Pending |
| PG-03 | Phase 45 | Pending |
| ART-01 | Phase 46 | Pending |
| ART-02 | Phase 46 | Pending |
| ART-03 | Phase 46 | Pending |
| CONF-01 | Phase 47 | Pending |
| CONF-02 | Phase 47 | Pending |

**Coverage:**
- v2.7 requirements: 11 total
- Mapped to phases: 11
- Unmapped: 0

---
*Requirements defined: 2026-04-29*
*Last updated: 2026-04-29 after v2.7 milestone start*
