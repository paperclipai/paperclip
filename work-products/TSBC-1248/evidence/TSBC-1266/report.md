# Paperclip Model Benchmark — `run-20260725-214841`

_Generated 2026-07-25T21:01:39+00:00. Judge: **claude-opus** (blind, uniform). 34 runs, 0 failures._

**Models:** `grok-4.5`

> Quality is a 0–1 blend of deterministic checks and the blind judge. **`q/1k-out`** = quality per 1,000 **output** tokens — the primary value metric, because total tokens are ~95% fixed CLI system-prompt overhead (a harness artifact) that would otherwise reward whichever CLI ships the smallest base prompt rather than the better model. `in`/`out` = mean input/output tokens. Models run in a neutralized temp CWD — base-model capability, not the local agent harness.

## Overall (mean across roles)

| Model | Mean quality | q/1k-out | q/1k-total |
|---|---|---|---|
| Grok 4.5 | 0.944 | 17.878 | 3.908 |

**Best overall quality:** Grok 4.5

## Per-role results & recommendations

### `cto`

| Model | Quality | q/1k-out | in | out | Success |
|---|---|---|---|---|---|
| Grok 4.5 | 0.975 | 22.853 | 232 | 68 *(est)* | 100% |

**→ Recommended for `cto`: Grok 4.5** — peak quality Grok 4.5 (0.975) is also the cheapest near-peak  
_Peak quality: Grok 4.5 · Most output-efficient: Grok 4.5_

### `ledger`

| Model | Quality | q/1k-out | in | out | Success |
|---|---|---|---|---|---|
| Grok 4.5 | 0.992 | 26.547 | 137 | 41 *(est)* | 100% |

**→ Recommended for `ledger`: Grok 4.5** — peak quality Grok 4.5 (0.992) is also the cheapest near-peak  
_Peak quality: Grok 4.5 · Most output-efficient: Grok 4.5_

### `cv-review`

| Model | Quality | q/1k-out | in | out | Success |
|---|---|---|---|---|---|
| Grok 4.5 | 0.864 | 4.233 | 148 | 237 *(est)* | 100% |

**→ Recommended for `cv-review`: Grok 4.5** — peak quality Grok 4.5 (0.864) is also the cheapest near-peak  
_Peak quality: Grok 4.5 · Most output-efficient: Grok 4.5_

## grok-4.3 vs grok-4.20 — the verdict

- Role-level quality wins: **grok-4.20 = 0**, **grok-4.3 = 0**, ties = 0
- Overall mean quality: grok-4.3 — · grok-4.20 —
- Overall mean q/1k-out: grok-4.3 — · grok-4.20 —
- _(4.20 is the reasoning variant — it spends more output/thoughts tokens, so a quality win only justifies tiering onto it if it beats 4.3's efficiency cost.)_

## TSBC closeout gate

> If this run will feed a TSBC issue, report, catalog row, or rollout decision, do not stop at the recommendation tables above.

- Run ID: `run-20260725-214841`
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
- Environment: `Paperclip benchmark harness; neutralized temp CWD; finished 2026-07-25T21:01:39+00:00`
- Records path: `benchmark/results/run-20260725-214841/report.md`, `benchmark/results/run-20260725-214841/runs.json`
- Suite hash(es): `cto=9178417ea7411729ec604cd6f0f72637a785d4d0f99ddd564fdfd0d4d603c31d`, `cv-review=4a12f7840060d3340e31887045177b943ccfc26aece2989d42f2e6f31a2b2c61`, `ledger=22a4d94c78402d54f39f0cd1b4eb6a12005acecfa3e2d429551928eca686300e`
- Prompt/system hash: record the prompt/agent/system hash, or `none` / `not_preserved:<why missing>`
- Failure-library IDs: list linked failures, or `none` with why that absence is meaningful
- Any `not_preserved:*` field must explain why the artifact is missing; blank fields are not acceptable
- Next gate: `catalog_only` / `create_candidate_pack` / `run_opco_live_proof` / `adopt` / `reject` / `rerun` / `supersede`
- Issue may not move to `done` until the PDF artifact is attached and cited in the closeout evidence

