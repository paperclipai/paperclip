# CMPAAA-115 Phase A Failure Drill Scaffold v1

- Source issue: [CMPAAA-115](/CMPAAA/issues/CMPAAA-115)
- Execution issue: [CMPAAA-126](/CMPAAA/issues/CMPAAA-126)
- Baseline alignment: [CMPAAA-49](/CMPAAA/issues/CMPAAA-49)
- Owner: CTO

## 1) Drill Metadata

- Drill id: `{{drill_id}}`
- Drill window: `{{window_start}} ~ {{window_end}}`
- Candidate scope: `{{candidate_scope}}`
- Input artifact: `{{input_artifact_ref}}`
- Executor: `{{executor}}`
- Reviewer: `{{reviewer}}`

## 2) Controlled Failure Injection

| Step | Action | Expected signal | Evidence |
|---|---|---|---|
| 1 | Pick one replay candidate and force failure path | `traceback_status=failed` | `run://...` |
| 2 | Capture failure root cause | `root_cause_category` non-empty | `traceback://...` |
| 3 | Emit alert and escalate | `alert_priority` + escalation receiver recorded | `alert://...` |
| 4 | Start mitigation | mitigation start timestamp present | `incident://...` |
| 5 | Close and measure latency | handling latency field present | `postmortem://...` |

## 3) Failure Record (Single Sample Minimum)

At least one failed record is required.

| sample_id | candidate_id | run_id | lineage_id | traceback_request_id | checked_at | traceback_status | root_cause_category | source_gate_decision_id | alert_id | alert_priority | escalation_receiver | escalation_sent_at | escalation_acknowledged_at | mitigation_started_at | resolved_at | handling_latency_minutes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| {{sample_id}} | {{candidate_id}} | {{run_id}} | {{lineage_id}} | {{traceback_request_id}} | {{checked_at}} | failed | {{root_cause_category}} | {{source_gate_decision_id}} | {{alert_id}} | {{alert_priority}} | {{escalation_receiver}} | {{escalation_sent_at}} | {{escalation_acknowledged_at}} | {{mitigation_started_at}} | {{resolved_at}} | {{handling_latency_minutes}} |

## 4) Required Root-Cause Taxonomy

- `lineage-node-missing`
- `lineage-edge-missing`
- `lineage-field-missing`
- `traceback-runtime-failure`

## 5) Acceptance Checks

- At least one `failed` sample exists.
- Failed sample has `root_cause_category`, `alert_priority`, `escalation_receiver`, and `handling_latency_minutes`.
- `audit_evidence_refs` includes all three prefixes:
  - `lineage://`
  - `run://`
  - `traceback://`
- Escalation timestamps are ordered:
  - `escalation_sent_at <= escalation_acknowledged_at <= mitigation_started_at <= resolved_at`

## 6) Output Artifacts

- Drill record JSON:
  - `docs/cto/evidence/CMPAAA-115/samples/cmpaaa-115-failure-drill-record.sample.v1.json`
- Review note:
  - `docs/cto/evidence/CMPAAA-115/cmpaaa-115-phase-a-alert-escalation-template-v1.md`
