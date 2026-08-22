# [CMPAAA-126] Phase A Prewarm: failure-drill scaffold + escalation template + evidence contract

## Why

This PR delivers the first reviewable Phase A package for [CMPAAA-115](/CMPAAA/issues/CMPAAA-115) under [CMPAAA-126](/CMPAAA/issues/CMPAAA-126), aligned to [CMPAAA-49](/CMPAAA/issues/CMPAAA-49) shared evidence fields.

## Scope

- Add reusable failure-drill scaffold for controlled failure run rehearsal.
- Add alert-escalation template with priority/receiver/latency targets.
- Add evidence contract schema + sample record with CMPAAA-49 shared-field compatibility.
- Add validation scripts/outputs for machine-checkable acceptance evidence.

## Files

- `docs/cto/CMPAAA-126-phase-a-first-pr-prewarm-package-v1.md`
- `docs/cto/evidence/CMPAAA-115/README.md`
- `docs/cto/evidence/CMPAAA-115/cmpaaa-115-phase-a-failure-drill-scaffold-v1.md`
- `docs/cto/evidence/CMPAAA-115/cmpaaa-115-phase-a-alert-escalation-template-v1.md`
- `docs/cto/evidence/CMPAAA-115/cmpaaa-115-failure-drill-record.v1.schema.json`
- `docs/cto/evidence/CMPAAA-115/samples/cmpaaa-115-failure-drill-record.sample.v1.json`
- `docs/cto/evidence/CMPAAA-115/validate_cmpaaa115_phase_a_package.py`
- `docs/cto/evidence/CMPAAA-115/cmpaaa-115-phase-a-validation-output.v1.json`

## Acceptance evidence

- Phase A package validator command:
  - `python3 docs/cto/evidence/CMPAAA-115/validate_cmpaaa115_phase_a_package.py`
- Validator output:
  - `schema_error_count = 0`
  - CMPAAA-49 shared fields present `11/11`
  - required evidence prefixes present (`lineage://`, `run://`, `traceback://`)
  - escalation timestamps ordered and latency check matched

## Risk / tradeoff notes

- Phase A proves contract readiness, not live production failure closure.
- Phase B remains gated by upstream dependency path and controlled run admission.

## Review checklist

- [ ] Shared field names match CMPAAA-49 exactly.
- [ ] Escalation fields required for failed sample are complete.
- [ ] Validation output attached in PR and matches current artifact versions.
- [ ] Phase B gate entry remains blocked until upstream run-path gate is confirmed.
