# TSBC-1502 - Stage 12 blocked-dedup recovery churn fix

Source issue: `/TSBC/issues/TSBC-1502`  
PDF filename: `TSBC-1502-report.pdf`  
Hypothesis verdict: `CONFIRMED`  
Dispatched follow-up key: `TSBC-1404`

Catalog row: `tsbc-1502-stage12-blocked-dedup-noop`  
Report date: `2026-07-30`  
Brand pack: `stack-lab`  
Adoption status: `benchmark_only`  
Readiness gate: `report_ready`  
Claims gate: `approved_internal`

## Hypothesis

A deliberate Stage 12 blocked-dedup / no-op summary should classify as
`blocked`, preserve the blocked disposition without comment churn, skip
successful-run-handoff recovery, and avoid stale reassignment loops.

## Method

Validation used the served Paperclip tree at `/Users/glad0s/paperclip`, where
the live server on port `3100` is running.

Evidence steps:

1. Verified the served liveness/routing implementation already contains the
   blocked-dedup classifier and blocked-disposition preservation path in
   `server/src/services/run-liveness.ts`,
   `server/src/services/blocked-dedup-noop.ts`, and
   `server/src/services/heartbeat.ts`.
2. Added a focused served-tree regression in
   `server/src/__tests__/heartbeat-process-recovery.test.ts` that seeds the
   exact Stage 12 fixture wording, the prior blocked-status comment, and an
   assertion that the adapter is not re-invoked after the no-op summary.
3. Re-ran the tight served-tree verification set:
   - `server/src/__tests__/heartbeat-auto-checkout.test.ts`
   - `server/src/__tests__/heartbeat-stale-queue-invalidation.test.ts`
   - `server/src/__tests__/heartbeat-process-recovery.test.ts -t "stage 12 blocked-dedup no-op"`
4. Attempted a bounded live rerun from the frozen
   `[TSBC-1262](/TSBC/issues/TSBC-1262)` wrapper with:

```sh
TSBC_R1_REPS=1 TSBC_R1_TASK_LIMIT=12 TSBC_R1_ALLOW_DUPLICATE_STAGE12=1 \
TSBC_R1_REPORT_STEM=TSBC-1502-stage12-rerun-2026-07-30 \
python3 -u run-paperclip-r1.py
```

Per the canonical TSKB delta cited below, `TSBC_R1_TASK_LIMIT` is prefix-only,
so this live attempt is supplemental evidence rather than a true Stage-12-only
selector.

## Data

Primary confirming evidence:

- Historical failing Stage 12 chain:
  - source run `734f8a83-f229-4c56-b5ef-b83b6aa2f35c`
  - corrective run `f5301752-f597-44ac-a04f-8a8dfca5cbb9`
  - follow-on assignment run `93b52803-1483-408d-a32b-f5419dd5dcfc`
- Served-tree code paths:
  - `server/src/services/run-liveness.ts`
  - `server/src/services/blocked-dedup-noop.ts`
  - `server/src/services/heartbeat.ts`
- Served-tree targeted regression/logs:
  - `work-products/TSBC-1502/evidence/vitest-heartbeat-routing.log`
  - `work-products/TSBC-1502/evidence/vitest-stage12-blocked-dedup.log`

Observed served verification results:

- `vitest-heartbeat-routing.log`: `Test Files 2 passed`, `Tests 31 passed`
- `vitest-stage12-blocked-dedup.log`: `Test Files 1 passed`, `Tests 1 passed`
- The focused Stage 12 regression proves:
  - no successful-run-handoff wake is queued;
  - no recovery notice comment is created;
  - the issue remains `blocked`;
  - the adapter executes only once for the source run.

Supplemental bounded live rerun evidence:

- Rerun root:
  `/Users/glad0s/.paperclip/instances/default/projects/e212ce50-b524-408c-b3d4-0c6108d8c2e2/f71e8665-3f38-4920-b777-348ec85b9071/_default/work-products/TSBC-1141/TSBC-1262/runs/paperclip-20260730-052221`
- Sample namespace:
  `/Users/glad0s/.paperclip/instances/default/projects/e212ce50-b524-408c-b3d4-0c6108d8c2e2/f71e8665-3f38-4920-b777-348ec85b9071/_default/work-products/TSBC-1141/sample-runs/TSBC-1502-stage12-rerun-2026-07-30-20260730T052221Z`
- The attempt advanced through sample 9, then was stopped after the earlier
  Stage 6/Stage 9 fixtures consumed the bounded window before Stage 12:
  - Stage 6 child issue `[TSBC-1508](/TSBC/issues/TSBC-1508)` resolved a
    successful-run handoff from source run
    `186a0e2d-285d-4bba-a428-166660bc53fa` via corrective run
    `4d3110a5-f5bf-4bbb-b316-28fcb59b5851`.
  - Stage 9 fixture `[TSBC-1509](/TSBC/issues/TSBC-1509)` was already queued
    with run `ed575378-93bb-4bb1-8b93-276488c8b57f` when the attempt was
    stopped.

## Hypothesis Verdict

`CONFIRMED`. The served regression and routing tests prove the targeted Stage 12
path now classifies as `blocked` and stays quiet instead of falling into
missing-disposition recovery churn. The bounded live rerun did not reach Stage
12, so it is supplemental and `INCONCLUSIVE` for later-stage runtime proof, but
it does not contradict the served fix.

## Executive Recommendation

Treat the Stage 12 platform fix as landed and unblock
`[TSBC-1404](/TSBC/issues/TSBC-1404)` for manager-owned closeout work. If a
fresh end-to-end proof is still desired, rerun the frozen `TSBC-1262` wrapper
only after earlier-stage fixture churn is clear; do not claim that
`TSBC_R1_TASK_LIMIT=12` isolates Stage 12 by itself.

Decision class: `benchmark_only`

## What Was Tested

| Field | Value |
|---|---|
| OpCo | `TSBC / Paperclip platform` |
| Task / role | `Stage 12 blocked-dedup no-op liveness routing` |
| Suite | `served heartbeat tests + frozen TSBC-1262 bounded rerun attempt` |
| Models | `codex_local for served tests; hermes_local grok-4.5 for bounded rerun` |
| Skill pack | `paperclip + paperclip-dev` |
| Prompt / agent file | `none; served repo implementation and test fixture` |
| Repetitions | `1 focused regression; 1 bounded rerun attempt` |
| Judge | `issue-state assertions plus preserved run evidence` |
| Scorer calibration | `pass` |
| Reproducibility fingerprint | `tsbc-1502-stage12-blocked-dedup-noop-2026-07-30` |

## Result Summary

| Lane | Score | Score band | Token metric | Adoption read |
|---|---:|---|---:|---|
| `served-tree targeted regression` | `1.00` | `pass` | `n/a` | `ready` |
| `bounded live rerun` | `0.50` | `inconclusive` | `not_measured` | `supplemental_only` |

## Benchmark Fairness Closeout

| Field | Record |
|---|---|
| Fairness verdict | `pass_with_caveat` |
| Evidence depth | `candidate` |
| Run IDs | `734f8a83-f229-4c56-b5ef-b83b6aa2f35c`, `f5301752-f597-44ac-a04f-8a8dfca5cbb9`, `93b52803-1483-408d-a32b-f5419dd5dcfc`, `186a0e2d-285d-4bba-a428-166660bc53fa`, `4d3110a5-f5bf-4bbb-b316-28fcb59b5851`, `ed575378-93bb-4bb1-8b93-276488c8b57f` |
| Repetitions per compared cell | `1 targeted rerun attempt; served regression tests` |
| Low-tail / min-score note | `not applicable; this is a state-machine regression proof, not a scored content benchmark` |
| Token / cost / runtime note | `quality_only; targeted Vitest proof, live rerun runtime only` |
| Scorer caveat | `The bounded live rerun did not reach Stage 12 because earlier preregistered stages consumed the prefix-limited task window.` |
| Failure-library IDs | `none` |
| Next gate | `rerun` |

## Token and Cost Read

`quality_only`. The acceptance criterion is correctness of liveness routing, not
token efficiency. The economically relevant point is that the served tests now
prove the no-op path without forcing repeated recovery churn or extra assignment
runs.

## Failure Analysis

The original defect was a classification gap: Stage 12 emitted useful output
describing a deliberate blocked-dedup no-op, but run liveness still labelled the
run `needs_followup`, which triggered successful-run-handoff recovery and a
follow-on assignment loop.

The bounded live rerun exposed a separate earlier-stage drag:

- Stage 6 child `[TSBC-1508](/TSBC/issues/TSBC-1508)` needed a corrective run
  before resolving its own successful-run handoff.
- Stage 9 fixture `[TSBC-1509](/TSBC/issues/TSBC-1509)` was already queued when
  the bounded attempt was stopped.

That earlier-stage runtime drag is not evidence against the Stage 12 fix, but it
does make the bounded live rerun `INCONCLUSIVE` for later-stage acceptance on
its own.

## Rollout Guidance

Adoption owner: `Bench-Manager` on `[TSBC-1404](/TSBC/issues/TSBC-1404)`  
Source OpCo rollout issue: `[TSBC-1404](/TSBC/issues/TSBC-1404)`  
Skill-pack install/attach notes: `none`  
Rollback owner and trigger: `Bench-Manager if future run-liveness or heartbeat edits reintroduce successful-run-handoff churn on blocked no-op fixtures`  
Previous lane / fallback route: `historical failing Stage 12 fixture chain cited above`  
Retest trigger: `any future edit to run-liveness, blocked-dedup parsing, heartbeat disposition preservation, or successful-run-handoff routing`  
Caveats for derivatives: `internal engineering proof only; do not present the bounded rerun as a Stage-12-only selector or a full-suite closeout`  

## Privacy And Public-Claim Gate

| Control | Value |
|---|---|
| Data class | `internal` |
| Redaction status | `not_needed` |
| Allowed evidence use | `internal/report` |
| Public claim level | `internal_only` |
| Public approval issue | `none` |
| Allowed public wording | `none` |

## Evidence

| Evidence | Link / path |
|---|---|
| Run id(s) | `734f8a83-f229-4c56-b5ef-b83b6aa2f35c`, `f5301752-f597-44ac-a04f-8a8dfca5cbb9`, `93b52803-1483-408d-a32b-f5419dd5dcfc`, `186a0e2d-285d-4bba-a428-166660bc53fa`, `4d3110a5-f5bf-4bbb-b316-28fcb59b5851`, `ed575378-93bb-4bb1-8b93-276488c8b57f` |
| Source issue(s) | `/TSBC/issues/TSBC-1502`, `/TSBC/issues/TSBC-1404`, `/TSBC/issues/TSBC-1496`, `/TSBC/issues/TSBC-1508`, `/TSBC/issues/TSBC-1509` |
| Records | `work-products/TSBC-1502/evidence/`, `.../TSBC-1262/runs/paperclip-20260730-052221/`, `.../sample-runs/TSBC-1502-stage12-rerun-2026-07-30-20260730T052221Z/` |
| Skill pack | `paperclip`, `paperclip-dev` |
| Proof bundle manifest | `work-products/TSBC-1502/TSBC-1502-report.md` |
| ROI / ledger issue | `not_measured` |
| Canonical TSKB delta | `/Users/glad0s/TSKB/KB/TSKB0047 [TSBC] - Lane Placement and Skill-Pack Adoption Tracker - v0.1 - 07-06/benchmark-fairness-protocol.md` |

## Render Command

```sh
~/scripts/brand-suite/brandsuite pdf --brand stack-lab -- --input /Users/glad0s/paperclip/work-products/TSBC-1502/TSBC-1502-report.md --out /Users/glad0s/paperclip/work-products/TSBC-1502/TSBC-1502-report.pdf --title "TSBC-1502 - Stage 12 blocked-dedup recovery churn fix"
```
