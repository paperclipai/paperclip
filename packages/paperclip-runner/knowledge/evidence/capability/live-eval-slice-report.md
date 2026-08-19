---
type: Evidence Report
title: Live Runner Eval Slice Report
description: Scored real-Codex capability matrix bound to its secret-free eval bundle.
generated: { by: process:capability-live-eval, at: 2026-08-11T18:14:30.145Z }
status: stable
---

# Runner eval slice — evb-ccfa51b713b10e13

- Bundle: `runnerd/codex-app-server@codex-app-server-v2 · gpt-5.5 · mock · 4 grants · prompt:capability-live-exact-call-v1 · faults:clean`
- Source: real model tool choice
- Cases: 16 · passed 16 · gate failures 0 · mean overall 1

## Dimension means

- hard_invariants: 1
- semantic_outcome: 1
- trajectory_restraint: 1
- trace_completeness: 1
- quality_efficiency: 1

## Cases

| case | source | counterpart | fault | gate | overall | outcome | trajectory | trace | efficiency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ap-approval-deny-01 | live_model | — | — | ok | 1 | 1 | 1 | 1 | 1 |
| ar-no-done-without-upload-01 | live_model | — | — | ok | 1 | 1 | 1 | 1 | 1 |
| bl-cancelled-not-resolved-01 | live_model | — | — | ok | 1 | 1 | 1 | 1 | 1 |
| cm-mention-structured-01 | live_model | — | — | ok | 1 | 1 | 1 | 1 | 1 |
| co-409-stop-01 | live_model | — | — | ok | 1 | 1 | 1 | 1 | 1 |
| dp-base-revision-01 | live_model | — | — | ok | 1 | 1 | 1 | 1 | 1 |
| er-blocked-dedup-01 | live_model | — | — | ok | 1 | 1 | 1 | 1 | 1 |
| hb-context-01 | live_model | — | — | ok | 1 | 1 | 1 | 1 | 1 |
| ix-checkbox-01 | live_model | — | — | ok | 1 | 1 | 1 | 1 | 1 |
| mh-blocked-handoff-01 | live_model | — | — | ok | 1 | 1 | 1 | 1 | 1 |
| rf-api-404-report-01 | live_model | — | — | ok | 1 | 1 | 1 | 1 | 1 |
| rs-dependency-blocked-wake-01 | live_model | — | — | ok | 1 | 1 | 1 | 1 | 1 |
| se-get-issue-01 | live_model | — | — | ok | 1 | 1 | 1 | 1 | 1 |
| st-backlog-park-01 | live_model | — | — | ok | 1 | 1 | 1 | 1 | 1 |
| su-crossteam-billing-01 | live_model | — | — | ok | 1 | 1 | 1 | 1 | 1 |
| wk-ask-mode-01 | live_model | — | — | ok | 1 | 1 | 1 | 1 | 1 |
