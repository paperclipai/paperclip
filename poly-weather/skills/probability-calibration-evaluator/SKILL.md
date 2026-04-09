---
name: probability-calibration-evaluator
description: >
  Evaluate the calibration of probabilistic forecasts produced by the
  Poly-weather system — check whether a predicted X% probability of an event
  actually occurs X% of the time in aggregate. Use on a weekly or monthly
  cadence to detect model miscalibration and trigger retraining alerts.
---

# Probability Calibration Evaluator

Measures how well the system's probabilistic forecasts are calibrated using
the reliability diagram, Brier score, and log-loss. Identifies over-confident
and under-confident prediction zones.

## Calibration Analysis

### Reliability Diagram (Reliability Plot)
- Bin predictions into 10 decile buckets (0–10%, 10–20%, …, 90–100%).
- For each bin, compute the empirical event frequency.
- Calibration error = `Σ |predicted_freq - empirical_freq| / 10`.
- Flag bins where `|predicted - empirical| > 0.1` as miscalibrated.

### Brier Score
- Compute Brier Score = `mean((predicted_prob - outcome)²)` across all predictions.
- Compare to baseline (e.g., always predicting the base rate).
- A Brier Score worse than the baseline indicates systematic miscalibration.

### Expected Calibration Error (ECE)
- Compute weighted ECE with `M=10` bins.
- ECE > 0.05 is a mild concern; ECE > 0.10 triggers a retraining alert.

### Calibration by Prediction Bucket
- Report per-bucket calibration:
  ```
  bucket_0-10:  predicted=0.05,  empirical=0.07   ✓
  bucket_10-20: predicted=0.15,  empirical=0.14   ✓
  bucket_80-90: predicted=0.85,  empirical=0.71   ✗ OVERCONFIDANT
  ```

## Output

Return:
- `{calibration_error: float, ece: float, brier_score: float, miscalibrated_buckets: string[], alert: boolean}`.
- `alert: true` if `ece > 0.10` or any bucket deviation > 0.15.

If alert is true, suggest which model version or forecast horizon is most likely miscalibrated.
