# CMPAAA-126 Phase A 首个可审 PR 预热包 v1

- Source issue: [CMPAAA-126](/CMPAAA/issues/CMPAAA-126)
- Parallel lane: [CMPAAA-115](/CMPAAA/issues/CMPAAA-115)
- Baseline contract: [CMPAAA-49](/CMPAAA/issues/CMPAAA-49)
- Status: Ready for first review
- Timestamp: 2026-04-30

## 1) Architecture Choices

1. Phase split for speed with audit control
   - Phase A delivers reusable drill scaffold, escalation template, and evidence field contract only.
   - Phase B remains gated by real failure-drill execution readiness.
2. Shared field contract lock to avoid lane drift
   - Keep CMPAAA-49 shared keys unchanged.
   - Add only CMPAAA-115 escalation fields required by acceptance.
3. Deterministic first-PR review surface
   - Package review on markdown templates + JSON schema + sample record + validation output.
   - Keep the package replayable without production write access.

## 2) Milestone Sequencing

1. 2026-04-30: Complete CMPAAA-126 Phase A package and validation output in workspace.
2. 2026-05-01 10:45 CST: Submit first reviewable PR with scaffold/template/schema/sample/validation evidence.
3. Post-review: Freeze shared field contract and open CMPAAA-115 Phase B gate-entry review.

## 3) Explicit Tradeoffs

- Gain
  - Starts CMPAAA-115 in parallel without waiting for full CMPAAA-114 completion.
  - Reduces reviewer ambiguity by freezing evidence keys before real drill execution.
- Cost
  - Phase A does not prove production drill closure.
  - CTO gatekeeping load increases because lane A and lane B now produce same-day deltas.

## 4) Risk Register

| Risk ID | Risk | Trigger | Mitigation | Owner |
|---|---|---|---|---|
| R126-1 | Shared field drift from CMPAAA-49 | Any shared key mismatch detected in schema/sample | Lock shared key list in validator and fail package check | CTO |
| R126-2 | Escalation evidence incomplete | Failed sample missing receiver/latency/timestamps | Schema required fields + ordering checks | CTO |
| R126-3 | PR misses checkpoint | No reviewable package by 2026-05-01 10:45 CST | Scope fixed to minimum reusable artifact set | CTO |

## 5) Success Metrics

- First reviewable PR contains:
  - failure drill scaffold,
  - alert escalation template,
  - field contract schema,
  - sample record,
  - validation output.
- Shared CMPAAA-49 field names match exactly (11/11).
- Sample escalation fields complete and timestamp ordering valid (100%).

## 6) Artifact Links

- [Evidence README](./evidence/CMPAAA-115/README.md)
- [Failure drill scaffold](./evidence/CMPAAA-115/cmpaaa-115-phase-a-failure-drill-scaffold-v1.md)
- [Alert escalation template](./evidence/CMPAAA-115/cmpaaa-115-phase-a-alert-escalation-template-v1.md)
- [Field contract schema](./evidence/CMPAAA-115/cmpaaa-115-failure-drill-record.v1.schema.json)
- [Sample record](./evidence/CMPAAA-115/samples/cmpaaa-115-failure-drill-record.sample.v1.json)
- [Validation script](./evidence/CMPAAA-115/validate_cmpaaa115_phase_a_package.py)
- [Validation output](./evidence/CMPAAA-115/cmpaaa-115-phase-a-validation-output.v1.json)
- [PR draft body](./evidence/CMPAAA-115/cmpaaa-126-phase-a-pr-draft-body-v1.md)
- [Checkpoint record (2026-04-30 18:48 CST)](./evidence/CMPAAA-115/cmpaaa-126-pr-checkpoint-2026-04-30-1848-cst.v1.json)
- [Checkpoint record (2026-05-01 00:48 CST)](./evidence/CMPAAA-115/cmpaaa-126-pr-checkpoint-2026-05-01-0048-cst.v1.json)

## 7) Next Critical Action

- Owner: CTO
- Date: 2026-05-01 10:45 CST
- Action: Open the first reviewable PR and request CEO review for Phase B gate entry.
