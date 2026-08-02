# Paperclip Model Benchmark — `run-20260725-215009`

_Generated 2026-07-25T20:59:06+00:00. Judge: **claude-opus** (blind, uniform). 32 runs, 0 failures._

**Models:** `grok-4.5`

> Quality is a 0–1 blend of deterministic checks and the blind judge. **`q/1k-out`** = quality per 1,000 **output** tokens — the primary value metric, because total tokens are ~95% fixed CLI system-prompt overhead (a harness artifact) that would otherwise reward whichever CLI ships the smallest base prompt rather than the better model. `in`/`out` = mean input/output tokens. Models run in a neutralized temp CWD — base-model capability, not the local agent harness.

## Overall (mean across roles)

| Model | Mean quality | q/1k-out | q/1k-total |
|---|---|---|---|
| Grok 4.5 | 0.962 | 24.374 | 4.629 |

**Best overall quality:** Grok 4.5

## Per-role results & recommendations

### `content`

| Model | Quality | q/1k-out | in | out | Success |
|---|---|---|---|---|---|
| Grok 4.5 | 0.927 | 20.142 | 151 | 61 *(est)* | 100% |

**→ Recommended for `content`: Grok 4.5** — peak quality Grok 4.5 (0.927) is also the cheapest near-peak  
_Peak quality: Grok 4.5 · Most output-efficient: Grok 4.5_

### `ops`

| Model | Quality | q/1k-out | in | out | Success |
|---|---|---|---|---|---|
| Grok 4.5 | 0.971 | 24.610 | 235 | 108 *(est)* | 100% |

**→ Recommended for `ops`: Grok 4.5** — peak quality Grok 4.5 (0.971) is also the cheapest near-peak  
_Peak quality: Grok 4.5 · Most output-efficient: Grok 4.5_

### `ceo`

| Model | Quality | q/1k-out | in | out | Success |
|---|---|---|---|---|---|
| Grok 4.5 | 0.989 | 28.370 | 128 | 50 *(est)* | 100% |

**→ Recommended for `ceo`: Grok 4.5** — peak quality Grok 4.5 (0.989) is also the cheapest near-peak  
_Peak quality: Grok 4.5 · Most output-efficient: Grok 4.5_

## grok-4.3 vs grok-4.20 — the verdict

- Role-level quality wins: **grok-4.20 = 0**, **grok-4.3 = 0**, ties = 0
- Overall mean quality: grok-4.3 — · grok-4.20 —
- Overall mean q/1k-out: grok-4.3 — · grok-4.20 —
- _(4.20 is the reasoning variant — it spends more output/thoughts tokens, so a quality win only justifies tiering onto it if it beats 4.3's efficiency cost.)_

## TSBC closeout gate

> If this run will feed a TSBC issue, report, catalog row, or rollout decision, do not stop at the recommendation tables above.

- Run ID: `run-20260725-215009`
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
- Environment: `Paperclip benchmark harness; neutralized temp CWD; finished 2026-07-25T20:59:06+00:00`
- Records path: `benchmark/results/run-20260725-215009/report.md`, `benchmark/results/run-20260725-215009/runs.json`
- Suite hash(es): `ceo=7b79fdf5d2ce80570fcfa85a1d04cd2c61e7093b8d2d1c735f7c4a07197a28c3`, `content=033a0a832aabf01236564fdbacb17e2fd0b3701f5a3f5242226a5c4149ea7f96`, `ops=af81fcc8c8acf9b45aac20aa118d2e0116e4e875fd9b8b4e4f07df614a7bef25`
- Prompt/system hash: record the prompt/agent/system hash, or `none` / `not_preserved:<why missing>`
- Failure-library IDs: list linked failures, or `none` with why that absence is meaningful
- Any `not_preserved:*` field must explain why the artifact is missing; blank fields are not acceptable
- Next gate: `catalog_only` / `create_candidate_pack` / `run_opco_live_proof` / `adopt` / `reject` / `rerun` / `supersede`
- Issue may not move to `done` until the PDF artifact is attached and cited in the closeout evidence

