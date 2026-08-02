# TSBC-1571 Retired-Alias Provenance Closeout

Source issue: [TSBC-1571](/TSBC/issues/TSBC-1571)  
Report date: `2026-07-30`  
PDF filename: `TSBC-1571-report.pdf`  
Brand pack: `stack-lab`  
Hypothesis verdict: `CONFIRMED`  
Dispatched follow-up key: `none required`  

## Hypothesis

Post-retirement xAI fast-alias benchmark rows can preserve the originally
requested label without double-counting Grok 4.3, and the benchmark harness can
prevent new retired-alias pins from silently passing served-model verification.

## Method

The implementation used the operator-verified May 15, 2026 xAI retirement as
the provenance boundary. The public xAI migration note maps the retired Grok 4
fast aliases to `grok-4.3` and maps `grok-code-fast-1` to `grok-build-0.1`;
the local Hermes `xai-oauth` model catalog also excludes the retired aliases and
exposes `grok-4.3` / `grok-build-0.1`.

Implementation steps:

1. Added `benchmark/model_provenance.py` as the single retired-alias map and
   ledger/report normalization helper.
2. Annotated the live benchmark ledger in place, preserving original model
   labels while adding correction fields.
3. Updated `benchmark/ledger.py`, `benchmark/report.py`, and
   `benchmark/costreport.py` so aggregate/ranking views fold corrected fast
   aliases into `grok-4.3`.
4. Updated `benchmark/adapters.py` so retired alias pins fail loudly with
   `failureReason: retired_model_alias`; `_served_model_matches_pin` no longer
   accepts token-overlap matches for retired aliases.
5. Removed retired aliases from active benchmark rosters, Paperclip-lane agent
   mappings, pricing keys, and helper-script defaults, while keeping the
   denylist/provenance/test references.
6. Updated the canonical model-watch KB and the live 07:30 model-watch routine
   so future config, lane, and benchmark-matrix changes check for the retired
   aliases before use.

## Data

Ledger annotation result:

| Field | Value |
|---|---:|
| Rows annotated | 2,003 |
| `model_original = grok-4-fast` | 864 |
| `model_original = grok-4.1-fast` | 1,139 |
| Rows with `served_model_corrected = grok-4.3` | 2,003 |
| Effective `grok-4.3` rows after fold | 2,594 |
| Effective `grok-4-fast` rows after fold | 0 |
| Effective `grok-4.1-fast` rows after fold | 0 |

Ledger backup:

- `benchmark/ledger/results.jsonl.bak-tsbc-1571-retired-alias-20260730185435`

Matcher diff:

- `benchmark/adapters.py`: rejects retired alias pins before live calls and
  rejects self-reported retired aliases after AGY probing.
- `benchmark/model_provenance.py`: central map for retired aliases, cutoff date,
  annotation fields, and failure payloads.
- Failure payload includes `failureReason: retired_model_alias`,
  `servedModelVerified: false`, and `servedModelMismatch: true`.
- `_served_model_matches_pin` returns false for retired pin aliases even when an
  API echoes the requested alias or overlaps tokens with the served model.

Aggregate/ranking fold:

- `benchmark/ledger.py`: `read_all`, `query`, and `passes` return effective
  model IDs for reporting without destructively rewriting history.
- `benchmark/report.py`: aggregate cells normalize rows through
  `model_effective` / `served_model_corrected`.
- `benchmark/costreport.py`: model normalization uses the same effective ID.

Active config hygiene:

| Surface | Retired aliases remaining as runnable pins |
|---|---:|
| `models` / `models_catalog` ids | 0 |
| `model_arg` values | 0 |
| Paperclip agentic lane agent keys | 0 |
| Pricing keys | 0 |

Expected remaining references are limited to the denylist, provenance map,
model-watch runbook text, and tests.

## Verification

Passed:

- `python3 -m unittest test_harness_gates.py` from `benchmark/` -> 12 tests.
- `python3 -m py_compile benchmark/adapters.py benchmark/ledger.py benchmark/report.py benchmark/costreport.py benchmark/model_provenance.py benchmark/cascade.py benchmark/per_task_compare.py benchmark/team_bench.py benchmark/smoke_cheap.py benchmark/run_disposition_shadow.py benchmark/tsbc_713_coverage.py`.
- `python3 -m json.tool benchmark/config.json >/dev/null`.
- `python3 bench.py all --dry-run` -> default roster includes `grok-4.3` and
  `grok-4.20`, and excludes the retired fast aliases.
- Config hygiene assertion -> retired aliases absent from active model ids,
  model args, Paperclip agent keys, and pricing keys.
- Ledger fold assertion -> `grok-4.3: 2594`, `grok-4-fast: 0`,
  `grok-4.1-fast: 0`, annotated read rows `2003`.
- `python3 ledger.py query content grok-4-fast --days 60` -> query folds the
  requested retired alias to `grok-4.3` and records `requestedModelQuery`.

Not run:

- Full repo typecheck/build/test. The change is scoped to the Python benchmark
  harness, benchmark configs, the live benchmark ledger, and the model-watch
  routine/KB.

## Verdict

`CONFIRMED`. Historical post-cutoff fast-alias rows now preserve request
provenance while aggregating under the served Grok 4.3 identity, new retired
alias pins fail served-model verification loudly, and model-watch now blocks
future lane/config/bench pins for the retired aliases.

## Evidence

- Work-product root: `work-products/TSBC-1571/`
- Report source: `work-products/TSBC-1571/TSBC-1571-report.md`
- PDF render: `work-products/TSBC-1571/TSBC-1571-report.pdf`
- Ledger backup:
  `benchmark/ledger/results.jsonl.bak-tsbc-1571-retired-alias-20260730185435`
- Source doc: `https://docs.x.ai/developers/migration/may-15-retirement`
- Hermes catalog evidence: `/Users/glad0s/.hermes/provider_models_cache.json`
- Canonical KB reference:
  `/Users/glad0s/TSKB/KB/TSKB0056 [ALL] - Model-Watch & New-Model Intake Runbook - v1.0 - 07-11.md`
- KB index reference: `/Users/glad0s/TSKB/KB/INDEX.md`
- Live routine updated: `94bec39d-c427-4016-a282-de2eb5e83151`

## Gate Checks

- Directive completeness: no `DEVIATION`; ledger, matcher, and model-watch
  requirements were all implemented.
- Payload verification: exact retired-alias matcher and ledger-fold behavior
  were exercised in focused tests and direct ledger assertions.
- Routine semantics: only the 07:30 model-watch checklist text changed; cadence
  and schedule ownership were not changed.
- Artifact custody: source and PDF render are preserved under
  `work-products/TSBC-1571/`; the PDF is uploaded before issue close.

Never-again gates checked: G2, G3, G7, G8, G9, G10. Evidence: this report and
the attached Paperclip PDF/source artifacts. Unsatisfied gates: none.

## Render Command

```sh
brandsuite pdf --brand stack-lab -- --input work-products/TSBC-1571/TSBC-1571-report.md --out work-products/TSBC-1571/TSBC-1571-report.pdf --title "TSBC-1571 Retired-Alias Provenance Closeout"
```
