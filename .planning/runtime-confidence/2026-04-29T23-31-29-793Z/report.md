# RT2 Runtime Confidence

Status: accepted_debt
Generated: 2026-04-29T23:31:29.793Z
Release-host summary: `.planning/release-host-runs/2026-04-29T23-14-48-030Z/summary.json`
Milestone gate: passed

| Blockers | Accepted Debt | Deferred Scope | Pending | Passed Signals |
|----------|---------------|----------------|---------|----------------|
| 0 | 1 | 4 | 0 | 1 |

## Blockers

None.

## Accepted Debt

| Code | Owner | Source | Reason | Closure Command |
| --- | --- | --- | --- | --- |
| windows_default_disabled | db | .planning/release-host-runs/2026-04-29T23-14-48-030Z/summary.json | embedded Postgres tests are disabled by default on Windows; run the focused host-ready command to verify runtime coverage | run pnpm rt2:embedded-postgres-host-ready on a Windows release host |

## Deferred Future Scope

| Item | Source | Reason |
| --- | --- | --- |
| Native/mobile distribution | .planning/REQUIREMENTS.md | Requires the v2.7 release confidence foundation first. |
| Cross-company knowledge federation | .planning/REQUIREMENTS.md | Outside trusted single-company confidence gate for this milestone. |
| Provider-backed eval mandate | .planning/REQUIREMENTS.md | Deterministic local and CI fallback remains required. |
| New Jarvis autonomous apply behavior | .planning/REQUIREMENTS.md | Direct apply remains approval-first future scope. |

## Release Host Attempts

| Slice | Suite | Status | Owner | Duration | Retry |
| --- | --- | --- | --- | --- | --- |
| embedded-postgres-windows-default-skip | embedded-postgres | accepted_debt | db | 0ms | run pnpm rt2:embedded-postgres-host-ready on a Windows release host |

## v2.7 Requirement Evidence

| Requirement | Phase | Status | Traceability | Verification | Validation |
| --- | --- | --- | --- | --- | --- |
| REL-01 | 44 | passed | Complete | .planning/phases/44-release-host-verification-harness/44-VERIFICATION.md | .planning/phases/44-release-host-verification-harness/44-VALIDATION.md |
| REL-02 | 44 | passed | Complete | .planning/phases/44-release-host-verification-harness/44-VERIFICATION.md | .planning/phases/44-release-host-verification-harness/44-VALIDATION.md |
| REL-03 | 44 | passed | Complete | .planning/phases/44-release-host-verification-harness/44-VERIFICATION.md | .planning/phases/44-release-host-verification-harness/44-VALIDATION.md |
| PG-01 | 45 | passed | Complete | .planning/phases/45-embedded-postgres-runtime-coverage/45-VERIFICATION.md | .planning/phases/45-embedded-postgres-runtime-coverage/45-VALIDATION.md |
| PG-02 | 45 | passed | Complete | .planning/phases/45-embedded-postgres-runtime-coverage/45-VERIFICATION.md | .planning/phases/45-embedded-postgres-runtime-coverage/45-VALIDATION.md |
| PG-03 | 45 | passed | Complete | .planning/phases/45-embedded-postgres-runtime-coverage/45-VERIFICATION.md | .planning/phases/45-embedded-postgres-runtime-coverage/45-VALIDATION.md |
| ART-01 | 46 | passed | Complete | .planning/phases/46-artifact-and-uat-truth-alignment/46-VERIFICATION.md | .planning/phases/46-artifact-and-uat-truth-alignment/46-VALIDATION.md |
| ART-02 | 46 | passed | Complete | .planning/phases/46-artifact-and-uat-truth-alignment/46-VERIFICATION.md | .planning/phases/46-artifact-and-uat-truth-alignment/46-VALIDATION.md |
| ART-03 | 46 | passed | Complete | .planning/phases/46-artifact-and-uat-truth-alignment/46-VERIFICATION.md | .planning/phases/46-artifact-and-uat-truth-alignment/46-VALIDATION.md |
| CONF-01 | 47 | passed | Complete | .planning/phases/47-runtime-confidence-operations-surface/47-VERIFICATION.md | .planning/phases/47-runtime-confidence-operations-surface/47-VALIDATION.md |
| CONF-02 | 47 | passed | Complete | .planning/phases/47-runtime-confidence-operations-surface/47-VERIFICATION.md | .planning/phases/47-runtime-confidence-operations-surface/47-VALIDATION.md |
