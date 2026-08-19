---
type: Evidence Report
title: Runner Eval Fault Slice Report
description: Eight green/red behaviors with deterministic injected-fault receipts.
generated: { by: process:capability-live-eval, at: 2026-08-11T18:14:30.145Z }
status: stable
---

# Runner eval slice — evb-e6bd1cf42d51618a

- Bundle: `deterministic-harness/in-process@v1 · scripted-eval-agent · mock · 2 grants · prompt:deterministic-behavior-driver-v1 · faults:authorization+conflict+retry+provider_capability`
- Source: deterministic fault harness
- Cases: 16 · passed 8 · gate failures 3 · mean overall 0.691

## Dimension means

- hard_invariants: 0.813
- semantic_outcome: 0.75
- trajectory_restraint: 0.688
- trace_completeness: 1
- quality_efficiency: 0.875

## Cases

| case | source | counterpart | fault | gate | overall | outcome | trajectory | trace | efficiency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| checkout_context:green | deterministic_fault_harness | green | — | ok | 1 | 1 | 1 | 1 | 1 |
| checkout_context:red | deterministic_fault_harness | red | — | FAIL | 0 | 1 | 0 | 1 | 1 |
| revision_safe_plan_editing:green | deterministic_fault_harness | green | — | ok | 1 | 1 | 1 | 1 | 1 |
| revision_safe_plan_editing:red | deterministic_fault_harness | red | conflict | ok | 0.6500000000000001 | 0 | 1 | 1 | 1 |
| approval_denial:green | deterministic_fault_harness | green | — | ok | 1 | 1 | 1 | 1 | 1 |
| approval_denial:red | deterministic_fault_harness | red | authorization | ok | 0.35000000000000003 | 0 | 0 | 1 | 1 |
| interaction_continuation:green | deterministic_fault_harness | green | — | ok | 1 | 1 | 1 | 1 | 1 |
| interaction_continuation:red | deterministic_fault_harness | red | — | ok | 0.35000000000000003 | 0 | 0 | 1 | 1 |
| blocker_monitor:green | deterministic_fault_harness | green | — | ok | 1 | 1 | 1 | 1 | 1 |
| blocker_monitor:red | deterministic_fault_harness | red | provider_capability | ok | 0.8500000000000001 | 1 | 0.5 | 1 | 1 |
| artifact_registration:green | deterministic_fault_harness | green | — | ok | 1 | 1 | 1 | 1 | 1 |
| artifact_registration:red | deterministic_fault_harness | red | retry | ok | 0.85 | 1 | 1 | 1 | 0 |
| restraint_no_call:green | deterministic_fault_harness | green | — | ok | 1 | 1 | 1 | 1 | 1 |
| restraint_no_call:red | deterministic_fault_harness | red | — | FAIL | 0 | 0 | 0 | 1 | 1 |
| terminal_arbitration:green | deterministic_fault_harness | green | — | ok | 1 | 1 | 1 | 1 | 1 |
| terminal_arbitration:red | deterministic_fault_harness | red | — | FAIL | 0 | 1 | 0.5 | 1 | 0 |
