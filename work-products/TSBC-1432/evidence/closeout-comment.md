Done.

Acknowledging the reopen comment: the correction was right. I did not spend this heartbeat re-enforcing repetitions; `run.reps = 3`, `bench.py all --reps`, and the decision floor already existed. I rescope-handled TSBC-1432 as the recording defect: pass-level ledger evidence, requested vs served model fields, timestamps, failure reasons, and historical backfill.

What changed:

- `benchmark/bench.py` now records pass start/finish timestamps, run start/finish timestamps, requested model fields, served model fields, served-model verification, and mismatch flags in `runs.json`.
- `benchmark/adapters.py` now attaches request metadata uniformly and makes AGY run a same-run self-report probe before the task call. If the self-report disagrees with the requested pin, the pass fails with `failureReason: served_model_mismatch`.
- `benchmark/scoring.py` now leaves served-model mismatches unscored (`quality: null`).
- `benchmark/ledger.py` now writes `model_eval_pass` rows, derives `model_eval` aggregates from pass rows, exposes `ledger.py passes`, classifies failure reasons, and includes an idempotent expanded-schema backfill.
- `benchmark/README.md`, `benchmark/TSBC-CHARTER.md`, and canonical TSKB0047 now document the pass-ledger and AGY self-report rule.

Live ledger backfill:

- `ledger/results.jsonl` now has 7,872 rows: 1,295 `model_eval` aggregate rows and 4,852 `model_eval_pass` rows.
- All 1,295 `model_eval` rows are schema v2.
- 6,147 model-eval/pass rows now carry `reps`, `requested_model`, and `served_model`.
- Failed non-skipped pass rows: 37; failed pass rows without `failure_reason`: 0.
- Low-success aggregate rows: 2; low-success rows still carrying quality: 0; both have `suppressed_reason`.
- `gemini-pro` rows: 241; all 241 have `served_model_verified: false`.
- Historical repetition counts are `unknown` unless the recovered artifact explicitly carried `reps`; recovered pass counts are kept separately.
- The final mutating ledger backup is `benchmark/ledger/results.jsonl.bak-tsbc-1432-expanded-ledger-20260728164030`.

Verification:

- `python3 -m unittest test_harness_gates.py` -> 8 tests passed.
- `python3 -m py_compile bench.py ledger.py adapters.py scoring.py report.py benchlib.py` -> passed.
- `python3 bench.py all --roles cto --models grok-4.3 --max-tasks-per-role 1 --dry-run` -> confirms `reps   : 3 (decision floor 3)`.
- Expanded backfill rerun -> `{ "changed": 0, "pass_rows_added": 0, "backup": null }`.
- `python3 ledger.py query cto agy-claude-opus-4.6 --days 120 --min 1` -> `nDecisionGradeResults: 0`, `suppressedResults: 1`, `passRows: 12`.
- PDF render verified: A4, 4 pages, required sections present.

Artifacts:

- Revised PDF: [TSBC-1432 Revised Report PDF](/api/attachments/8a50eaf9-ae55-46b0-97b8-084c5e0c9f49/content)
- Report source: [TSBC-1432 Revised Report Source](/api/attachments/619f28b5-7d3a-4546-aaa7-2f25fc87ee9c/content)
- Evidence bundle: [TSBC-1432 Evidence Bundle](/api/attachments/a5a27912-af8f-4a51-8b81-60a4334a2f69/content)
- Local evidence root: `work-products/TSBC-1432/evidence/`

TSKB delta:

- Updated `/Users/glad0s/TSKB/KB/TSKB0047 [TSBC] - Lane Placement and Skill-Pack Adoption Tracker - v0.1 - 07-06/benchmark-fairness-protocol.md`.

Not run: full repo typecheck/build/test, because this patch is scoped to the Python benchmark harness and live benchmark ledger.

No DEVIATION.
