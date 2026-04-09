---
name: forecast-provenance-auditor
description: >
  Audit the provenance chain for weather and macro forecasts consumed by the
  Poly-weather strategy — verify that forecast data is sourced from declared
  models, timestamped correctly, and not stale or contaminated by look-ahead
  bias. Use when ingesting new forecast data or before executing on a signal.
---

# Forecast Provenance Auditor

Traces every forecast data point back to its source model and verifies the
chain of custody to prevent look-ahead bias or data contamination.

## Provenance Checks

### Source Declaration
- Every forecast record carries a `source_model` tag matching a known model
  in the declared model registry.
- The model version (e.g., `weather_model_v1.2.3`) is recorded.
- No forecast is attributed to a model that was not the declared input to
  the signal generation pipeline.

### Timestamp Integrity
- `forecast_generated_at` ≤ `signal_evaluated_at` ≤ `trade_executed_at`.
- No forecast has a `forecast_generated_at` in the future (relative to ingestion time).
- Forecast staleness: reject forecasts older than `max_forecast_age_hours` unless
  a `stale_override` flag is present with an authorized signer.

### Look-Ahead Bias Prevention
- For backtested forecasts: `forecast_time` must be ≤ the bar timestamp used
  for signal evaluation.
- Verify that no feature in the forecast model uses data with a timestamp
  later than `forecast_time`.

### Model Drift Detection
- Track rolling distribution of forecast outputs per model.
- Flag if the Kullback-Leibler divergence between the current forecast
  distribution and the 30-day baseline exceeds a threshold (configurable,
  default 0.1).

## Output

Return `{provenance_valid: boolean, issues: ProvenanceIssue[], stale_forecasts: string[]}`.

If `provenance_valid` is false, do not act on the affected forecasts until resolved.
