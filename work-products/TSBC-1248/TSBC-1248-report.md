# TSBC-1248 Grok-4.5 Decision Matrix Closeout

PDF filename: `TSBC-1248-report.pdf`

## Hypothesis

`grok-4.5` had zero bare decision-matrix coverage when TSBC-1248 was opened. If the model materially improves over `grok-4.3` / `grok-4.20` on the agentic suites, the sister-failover order in TSBC-1141 needs that evidence before it is locked.

## Method

- Scope: `ceo`, `cto`, `engineer`, `paperclip`, `auditor`, `ledger`, `quant`, `ops`, `content`, `cv-review`.
- Model cell: bare `grok-4.5`, no skill or agent-file variants.
- Judge: `claude-opus`, matching the comparison rows.
- Acceptance gate applied per the TSBC-1248 directive: `>=10` samples per suite cell.
- Gemini / antigravity was not run.
- The missing `paperclip` cell was recovered from the completed TSBC-1404 / TSBC-1262 v4 paperclip rerun evidence and ingested through `benchmark/ledger.py record --run run-20260728-144413 --company TSBC --kind bench`.

## Data

All ten requested suites now have a bare `kind=model_eval` row for `model=grok-4.5` in `/Users/glad0s/paperclip/benchmark/ledger/results.jsonl`.

| suite | grok-4.5 n/q/run | vs grok-4.3 | vs grok-4.20 |
|---|---:|---|---|
| ceo | n=11 q=0.9888 `run-20260725-215009` | no prior row | no prior row |
| cto | n=12 q=0.9748 `run-20260725-214841` | beats (+0.0577) vs q=0.9171 n=3 `run-20260620-104931` | beats (+0.0261) vs q=0.9487 n=3 `run-20260620-104931` |
| engineer | n=12 q=0.9584 `run-20260725-220747` | loses (-0.0255) vs q=0.9839 n=7 `run-20260614-160813` | loses (-0.0209) vs q=0.9793 n=7 `run-20260614-160813` |
| paperclip | n=12 q=0.7910 `run-20260728-144413` | beats (+0.0192) vs q=0.7718 n=12 `run-20260620-234030` | loses (-0.0257) vs q=0.8167 n=12 `run-20260620-215706` |
| auditor | n=12 q=0.9821 `run-20260725-220747` | matches (+0.0038) vs q=0.9783 n=3 `run-20260620-104931` | beats (+0.0288) vs q=0.9533 n=3 `run-20260620-104931` |
| ledger | n=12 q=0.9921 `run-20260725-214841` | beats (+0.0171) vs q=0.9750 n=1 `run-20260620-103531` | no prior row |
| quant | n=12 q=0.9904 `run-20260725-220747` | matches (+0.0087) vs q=0.9817 n=3 `run-20260620-104931` | matches (+0.0087) vs q=0.9817 n=3 `run-20260620-104931` |
| ops | n=10 q=0.9707 `run-20260725-215009` | loses (-0.0229) vs q=0.9936 n=6 `run-20260614-160813` | beats (+0.0158) vs q=0.9549 n=6 `run-20260614-160813` |
| content | n=11 q=0.9268 `run-20260725-215009` | matches (+0.0049) vs q=0.9219 n=6 `run-20260614-160813` | beats (+0.0390) vs q=0.8878 n=6 `run-20260614-160813` |
| cv-review | n=10 q=0.8638 `run-20260725-214841` | beats (+0.0294) vs q=0.8344 n=6 `run-20260620-180922` | beats (+0.0512) vs q=0.8126 n=30 `run-20260728-165618` |

Paperclip callout: the issue named the prior `grok-4.3` paperclip score `0.543` as the single result driving grok's low cross-agentic rank. The new `grok-4.5` paperclip score is `0.7910` on 12 samples, so it does not repeat that collapse. Against the latest bare ledger row for `grok-4.3`, it is also higher (`0.7910` vs `0.7718`); against the latest bare `grok-4.20` paperclip row, it is lower (`0.7910` vs `0.8167`).

Ledger details:

- New aggregate row: line `8453`, `kind=model_eval`, `test_class=paperclip`, `model=grok-4.5`, `sample_count=12`, `quality=0.7910`, `judge=claude-opus`.
- New pass rows: lines `8441` through `8452`, `kind=model_eval_pass`, same run id.
- Staged run directory: `/Users/glad0s/paperclip/benchmark/results/run-20260728-144413`.
- Source evidence: `/Users/glad0s/.paperclip/instances/default/projects/e212ce50-b524-408c-b3d4-0c6108d8c2e2/f71e8665-3f38-4920-b777-348ec85b9071/_default/work-products/TSBC-1141/TSBC-1262/TSBC-1404-rerun-2026-07-28-v4.json`.

Schema note: the newly ingested paperclip row carries the current ledger helper's `reps=1` / `decision_band=candidate` metadata because the post-TSBC-1432 harness distinguishes per-task repetition from total sample count. TSBC-1248's explicit G8 acceptance parameter is `>=10 samples/cell`; all claimed cells meet that issue-level gate, and the comparison rows are still the same bare suite and same judge family requested by TSBC-1248 / TSBC-1141.

## Verdict

CONFIRMED. The `grok-4.5` bare matrix is now complete for the ten TSBC-1248 suites at the issue-stated `>=10` sample gate. `grok-4.5` beats or matches most comparison cells, loses the `engineer` suite to both older grok rows, loses `ops` to `grok-4.3`, and lands between `grok-4.3` and `grok-4.20` on the critical `paperclip` suite.

## Follow-Up Key

`TSBC-1141-failover-order-refresh`: consume these completed `grok-4.5` rows when finalizing the portfolio sister-failover order in TSBC-1141. No new child issue was required in this heartbeat because the blocking paperclip sample evidence already existed and the missing ledger row was appended directly.

## Artifacts

- Report source: `/Users/glad0s/paperclip/work-products/TSBC-1248/TSBC-1248-report.md`
- PDF render: `/Users/glad0s/paperclip/work-products/TSBC-1248/TSBC-1248-report.pdf`
- Paperclip child reports: `/Users/glad0s/paperclip/work-products/TSBC-1248/TSBC-1265/TSBC-1265-child-report.md`, `/Users/glad0s/paperclip/work-products/TSBC-1248/evidence/TSBC-1266/child-report.md`, `/Users/glad0s/paperclip/work-products/TSBC-1248/TSBC-1267/TSBC-1267-child-report.md`
- TSKB delta: none; no reusable process change beyond the issue-specific backfill and closeout.
