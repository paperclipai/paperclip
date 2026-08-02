# Paperclip Model Benchmark — `run-20260725-220747`

_Generated 2026-07-25T21:18:42+00:00. Judge: **claude-opus** (blind, uniform). 36 runs, 0 failures._

**Models:** `grok-4.5`

> Quality is a 0–1 blend of deterministic checks and the blind judge. **`q/1k-out`** = quality per 1,000 **output** tokens — the primary value metric, because total tokens are ~95% fixed CLI system-prompt overhead (a harness artifact) that would otherwise reward whichever CLI ships the smallest base prompt rather than the better model. `in`/`out` = mean input/output tokens. Models run in a neutralized temp CWD — base-model capability, not the local agent harness.

## Overall (mean across roles)

| Model | Mean quality | q/1k-out | q/1k-total |
|---|---|---|---|
| Grok 4.5 | 0.977 | 16.056 | 3.601 |

**Best overall quality:** Grok 4.5

## Per-role results & recommendations

### `engineer`

| Model | Quality | q/1k-out | in | out | Success |
|---|---|---|---|---|---|
| Grok 4.5 | 0.958 | 6.451 | 202 | 176 *(est)* | 100% |

**→ Recommended for `engineer`: Grok 4.5** — peak quality Grok 4.5 (0.958) is also the cheapest near-peak  
_Peak quality: Grok 4.5 · Most output-efficient: Grok 4.5_

### `auditor`

| Model | Quality | q/1k-out | in | out | Success |
|---|---|---|---|---|---|
| Grok 4.5 | 0.982 | 14.086 | 204 | 82 *(est)* | 100% |

**→ Recommended for `auditor`: Grok 4.5** — peak quality Grok 4.5 (0.982) is also the cheapest near-peak  
_Peak quality: Grok 4.5 · Most output-efficient: Grok 4.5_

### `quant`

| Model | Quality | q/1k-out | in | out | Success |
|---|---|---|---|---|---|
| Grok 4.5 | 0.990 | 27.633 | 164 | 60 *(est)* | 100% |

**→ Recommended for `quant`: Grok 4.5** — peak quality Grok 4.5 (0.990) is also the cheapest near-peak  
_Peak quality: Grok 4.5 · Most output-efficient: Grok 4.5_

## grok-4.3 vs grok-4.20 — the verdict

- Role-level quality wins: **grok-4.20 = 0**, **grok-4.3 = 0**, ties = 0
- Overall mean quality: grok-4.3 — · grok-4.20 —
- Overall mean q/1k-out: grok-4.3 — · grok-4.20 —
- _(4.20 is the reasoning variant — it spends more output/thoughts tokens, so a quality win only justifies tiering onto it if it beats 4.3's efficiency cost.)_

## TSBC closeout gate

> If this run will feed a TSBC issue, report, catalog row, or rollout decision, do not stop at the recommendation tables above.

- Run ID: `run-20260725-220747`
- Issue-close PDF artifact: attach `TSBC-<issue>-report.pdf` before closing any TSBC test issue
- PDF contents: hypothesis, method, data, verdict `CONFIRMED` / `REFUTED` / `INCONCLUSIVE`, dispatched follow-up key
- Fairness verdict: `pass` / `pass_with_caveat` / `fail`
- Evidence depth: `directional` / `candidate` / `decision_grade` / `production_locked`
- Repetitions per compared cell: record the compared sample counts that support the recommendation
- Low-tail / min-score note: name the weak cell or confirm why the low-tail is acceptable
- Token / cost / runtime note or caveat: summarize the efficiency trade, or say what is missing
- Scorer lane: `claude-opus`
- Scorer calibration status: `pass` / `pass_with_caveat` / `needs_calibration` / `failed`
- Calibration set: record the known-good / known-bad / borderline anchors, or `not_preserved:<why missing>`
- Tie-break owner: name the human or agent adjudicator, or `not_preserved:<why missing>`
- Scorer caveat: record scorer separation/calibration status and any dependency on human review
- Fingerprint: use `<opco-or-portfolio>:<task-surface>:<lane>:<suite-or-run-id>:<date>`, or `not_preserved:<why missing>`
- Model version(s): `grok-4.5`
- Adapter type(s): `grok-4.5=hermes`
- Effort setting(s): `grok-4.5=cli_default`
- Scorer/rubric version: record the exact rubric + judge version, or `not_preserved:<why missing>`
- Environment: `Paperclip benchmark harness; neutralized temp CWD; finished 2026-07-25T21:18:42+00:00`
- Records path: `benchmark/results/run-20260725-220747/report.md`, `benchmark/results/run-20260725-220747/runs.json`
- Suite hash(es): `auditor=2a04b6f827eda607af0693e4fbbe2fe425b9ea1c5fb0574b0550ceaac640d913`, `engineer=b7373c2152d432ffadaa313c61133d110457a1e56402bf122dab21c5460d183f`, `quant=32b3563885d9e20631634bbef99975027564a4a43c6c29a6e45c153467654e2e`
- Prompt/system hash: record the prompt/agent/system hash, or `none` / `not_preserved:<why missing>`
- Failure-library IDs: list linked failures, or `none` with why that absence is meaningful
- Any `not_preserved:*` field must explain why the artifact is missing; blank fields are not acceptable
- Next gate: `catalog_only` / `create_candidate_pack` / `run_opco_live_proof` / `adopt` / `reject` / `rerun` / `supersede`
- Issue may not move to `done` until the PDF artifact is attached and cited in the closeout evidence

