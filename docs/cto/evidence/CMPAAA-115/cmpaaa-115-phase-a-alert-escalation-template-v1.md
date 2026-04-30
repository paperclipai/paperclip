# CMPAAA-115 Phase A Alert Escalation Template v1

- Source issue: [CMPAAA-115](/CMPAAA/issues/CMPAAA-115)
- Execution issue: [CMPAAA-126](/CMPAAA/issues/CMPAAA-126)
- Baseline references: [CMPAAA-49](/CMPAAA/issues/CMPAAA-49), [CMPAAA-79](/CMPAAA/issues/CMPAAA-79)

## 1) Trigger to Priority Mapping

| Trigger code | Priority | Escalation target | Receiver template | Freeze required |
|---|---|---|---|---|
| `TRACEBACK_RUNTIME_FAILURE` | P1 | 30 minutes | `risk-oncall` | no |
| `LINEAGE_MISSING_RATE_BREACH` | P1 | 30 minutes | `data-oncall` | no |
| `SOURCE_GATE_DECISION_MISSING` | P1 | 30 minutes | `research-platform-oncall` | no |
| `TRACEBACK_EVIDENCE_INCOMPLETE` | P2 | 120 minutes | `research-platform-oncall` | no |
| `FAILURE_DRILL_ESCALATION_TIMEOUT` | P0 | 15 minutes | `cto` | yes |

## 2) Escalation Record Template

| Field | Example | Notes |
|---|---|---|
| `alert_id` | `rksalrt-cmpaaa115-0001` | unique alert id |
| `alert_priority` | `P1` | from mapping table |
| `alert_trigger_code` | `TRACEBACK_RUNTIME_FAILURE` | from mapping table |
| `escalation_receiver` | `risk-oncall` | person or role |
| `escalation_target_minutes` | `30` | SLO target |
| `escalation_sent_at` | `2026-05-01T01:05:00Z` | UTC |
| `escalation_acknowledged_at` | `2026-05-01T01:10:00Z` | UTC |
| `mitigation_started_at` | `2026-05-01T01:12:00Z` | UTC |
| `resolved_at` | `2026-05-01T01:34:00Z` | UTC |
| `handling_latency_minutes` | `29` | `resolved_at - escalation_sent_at` |

## 3) Review Gate

- `handling_latency_minutes <= escalation_target_minutes` for P0/P1.
- P0 requires freeze action evidence in review notes.
- Any missing escalation timestamp fails the Phase A review gate.
