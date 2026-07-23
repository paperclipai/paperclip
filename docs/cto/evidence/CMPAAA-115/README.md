# CMPAAA-115 Failure-Path Evidence Bundle

- Source issue: [CMPAAA-115](/CMPAAA/issues/CMPAAA-115)
- Execution issues: [CMPAAA-126](/CMPAAA/issues/CMPAAA-126) (Phase A), [CMPAAA-115](/CMPAAA/issues/CMPAAA-115) (Phase B closeout)
- Field baseline: [CMPAAA-49](/CMPAAA/issues/CMPAAA-49)
- Decision issue linkback target: [CMPAAA-112](/CMPAAA/issues/CMPAAA-112)

## 1) Scope

This package includes both Phase A prewarm artifacts and a Phase B controlled failure-drill evidence bundle.

Phase A prewarm artifacts:

- Failure-drill scaffold
- Alert-escalation template
- Evidence field definition contract aligned with `docs/cto/evidence/CMPAAA-49/`

Phase B closeout artifacts:

- Controlled failure-drill run sample aligned with CMPAAA-49 field naming
- Dedicated validator for failure-path acceptance checks
- Validation output and closeout report for signoff review thread usage

## 2) Artifact Index

- `samples/cmpaaa-115-failure-drill-run.v1.json`
  - Controlled failure drill run package with one failed sample minimum.
- `validate_cmpaaa115_failure_drill.py`
  - Verifies failed-record completeness, escalation ordering, and target latency checks.
- `cmpaaa-115-failure-drill-validation-output.v1.json`
  - Captures Phase B acceptance check results.
- `cmpaaa-115-failure-drill-validation-report-v1.md`
  - Closeout summary with risk register and next critical action.
- `cmpaaa-126-phase-a-pr-draft-body-v1.md`
  - Ready-to-paste first-reviewable PR description for CMPAAA-126 Phase A.
- `cmpaaa-126-pr-checkpoint-2026-04-30-1848-cst.v1.json`
  - Checkpoint record with `pr_url` state, miss reason, and revised timestamp.
- `cmpaaa-126-pr-checkpoint-2026-05-01-0048-cst.v1.json`
  - Pre-deadline productivity refresh checkpoint with latest validation pass evidence and unchanged PR URL constraint.
- `cmpaaa-115-cmpaaa112-linkback-comment-template-v1.md`
  - Ready-to-post linkback comment for CMPAAA-112 signoff thread.
- `cmpaaa-115-phase-a-failure-drill-scaffold-v1.md`
  - Drill execution scaffold for one controlled failure run.
- `cmpaaa-115-phase-a-alert-escalation-template-v1.md`
  - Alert grading and escalation timing template.
- `cmpaaa-115-failure-drill-record.v1.schema.json`
  - Evidence field definitions and required contract.
- `samples/cmpaaa-115-failure-drill-record.sample.v1.json`
  - Sample record that passes field shape and naming expectations.

## 3) Field Alignment Guardrail

The schema keeps CMPAAA-49 core fields unchanged:

- `sample_id`
- `candidate_id`
- `run_id`
- `lineage_id`
- `traceback_request_id`
- `checked_at`
- `traceback_status`
- `missing_lineage_fields`
- `root_cause_category`
- `source_gate_decision_id`
- `audit_evidence_refs`

Phase A extends only escalation-related fields required by `CMPAAA-115` acceptance.

## 4) Review Checklist

- Verify field names exactly match `CMPAAA-49` for shared evidence keys.
- Verify escalation fields are complete for `failed` samples.
- Verify every review sample includes lineage/run/traceback references.

## 5) Validation Evidence

- `validate_cmpaaa115_phase_a_package.py`
  - Verifies schema/sample validity, shared-field compatibility with CMPAAA-49, and escalation timestamp ordering.
- `cmpaaa-115-phase-a-validation-output.v1.json`
  - Captures acceptance checks used for the first reviewable PR gate.
- `validate_cmpaaa115_failure_drill.py`
  - Verifies the controlled failure record package satisfies failure-path evidence acceptance.
- `cmpaaa-115-failure-drill-validation-output.v1.json`
  - Captures failure-path acceptance checks for remediation closeout evidence.
