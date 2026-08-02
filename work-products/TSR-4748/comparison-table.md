# TSR-4748 — R2 vs Incumbent CV-review meanQ validation

Parent gate: TSR-4723. Zero-API-spend hermes/grok lanes. Identical suite, judge, and dev tasks; only the model + agent-file differ.

## Conditions (identical across lanes)
- Suite: `cv-review/suite.json` sha256 `4a12f7840060d3340e31887045177b943ccfc26aece2989d42f2e6f31a2b2c61`
- Judge model: `grok-4.3`
- Tasks (full cv-review dev suite, 10 tasks): cv-title-inflation-gap, cv-unsubstantiated-metrics, cv-role-mismatch, cv-clean-calibration, cv-date-inconsistency, cv-pii-overshare, cv-benign-contract-overlap, cv-explained-career-break, cv-keyword-stuffed-role-mismatch, cv-team-metric-attribution
- Reps per task: 1 → samples/lane = 10
- API spend: $0 (hermes/grok local lanes)

## Lanes
- **Incumbent**: `grok-4.3`, agent-file `current` + all skills · run `probe-20260731-175238` · AF sha256 `f8d177f294590ac8c153a4094e97ee4b335f39ec7a279528da64fb47700736e0`
- **R2**: `grok-4.5`, agent-file `cv-review-agent-file-R2.md` (skills none) · run `probe-20260731-175733` · AF sha256 `fd189e4b279ac47e366984b2ab9f1b8c1b4782cc2433cd91d77ee3c19da0c7bf`

## Overall comparison

| lane | model | n | ok | meanQ | minQ | meanOut | meanIn | q/1k-out |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Incumbent | grok-4.3 | 10 | 10 | 0.990 | 0.950 | 1458 | 21617 | 0.979 |
| R2 | grok-4.5 | 10 | 10 | 0.995 | 0.975 | 176 | 558 | 14.894 |

**meanQ delta (R2 − incumbent): +0.005** → R2 is non-inferior (parity-or-better) on quality.
**Output-token efficiency:** R2 meanOut 176 vs incumbent 1458 (8.3× fewer output tokens for equal-or-better quality).

## Per-task quality

| task | incumbent meanQ | R2 meanQ | Δ (R2−inc) |
|---|---:|---:|---:|
| cv-title-inflation-gap | 0.950 | 1.000 | +0.050 |
| cv-unsubstantiated-metrics | 0.950 | 0.975 | +0.025 |
| cv-role-mismatch | 1.000 | 1.000 | +0.000 |
| cv-clean-calibration | 1.000 | 1.000 | +0.000 |
| cv-date-inconsistency | 1.000 | 1.000 | +0.000 |
| cv-pii-overshare | 1.000 | 0.975 | -0.025 |
| cv-benign-contract-overlap | 1.000 | 1.000 | +0.000 |
| cv-explained-career-break | 1.000 | 1.000 | +0.000 |
| cv-keyword-stuffed-role-mismatch | 1.000 | 1.000 | +0.000 |
| cv-team-metric-attribution | 1.000 | 1.000 | +0.000 |

## Verdict
- R2 (grok-4.5) meanQ ≥ incumbent (grok-4.3) across the full 10-task cv-review dev suite, at a large output-token reduction. Quality gate: **PASS (non-inferior)**.
- Evidence depth: **directional/candidate** (n=10, 1 rep/task, single condition). Clears the meanQ adoption gate that replaced the unsatisfiable shadow-order gate.
- Per TSR-4748 item 5: the live-order shadow phase stays a LATER gate only; it is NOT the blocker for this adoption decision.
