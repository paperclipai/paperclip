# In-Process QC Protocol

**Document code:** PAL-21-QC-002
**Date:** 2026-05-28
**Author:** CTO
**Status:** Final — ready for validation

---

## 1. Purpose

This document defines the in-process quality control checks to be performed during every batch of paint base manufacturing. These checks ensure process control before costly downstream steps (letdown, filling) and provide real-time feedback for process adjustment.

---

## 2. QC Hold Points

There are three mandatory QC hold points in every batch:

| Hold Point | Stage | Description | Max Hold Time |
|---|---|---|---|
| HP-1 | After grind (before letdown) | Verify fineness of grind and temperature | 30 min |
| HP-2 | After letdown (before final water) | Verify pH, viscosity (preliminary) | 30 min |
| HP-3 | Final batch (before filling) | Full finished product QC | 60 min |

**Rule:** No batch proceeds past a hold point until all checks pass and the QC operator signs off on the BMR.

---

## 3. Hold Point 1 — Grind Stage (HP-1)

| Test | Method | Instrument | Specification | Action if Out of Spec |
|---|---|---|---|---|
| Fineness of Grind | IS 101 (Hegman gauge) | Hegman gauge, 0–100 µm | ≥ 6 (≤ 25 µm) | Continue grind additional 5 min, re-test. If fail after 3 retries → reject batch, investigate disperser |
| Temperature | Dial thermometer / IR gun | IR thermometer | < 50°C | Stop disperser, cool vessel jacket or add chilled water. Do not proceed above 50°C |
| Dispersion time | Timer | Stopwatch | 15–25 min | Record actual; flag if outside range |
| Visual check | Visual | N/A | Smooth, uniform paste, no lumps | Reject batch if lumps visible |

### HP-1 Sampling
- Location: From the grind vessel at mid-depth, avoiding vortex
- Sample size: ~200 g in clean HDPE cup
- Label with batch number, stage, date, time, operator initials

---

## 4. Hold Point 2 — Letdown Stage (HP-2)

| Test | Method | Instrument | Specification | Action if Out of Spec |
|---|---|---|---|---|
| pH | ISO 787-9 | Calibrated pH meter | 8.5–9.0 | If <8.0 → add ammonia incrementally (0.05% w/w), re-test after 5 min. If >9.5 → add water (letdown), record deviation |
| Viscosity (Stormer KU) | ASTM D562 | Stormer viscometer | 95–110 KU (before final water) | If >110 KU → add letdown water, mix 5 min, re-test. If <95 KU → may need thickener addition (HASE pre-diluted 1:3 with water), add 0.1% increments |
| Visual — foam level | Visual | N/A | No persistent foam layer > 5 mm | Add 0.05% defoamer, mix 5 min, re-check |
| Emulsion addition time | Timer | Stopwatch | ≥ 5 min per 100 L batch | Record actual time. If added too quickly → note for operator retraining |

### HP-2 Sampling
- Location: From letdown vessel, 50 mm below surface, avoiding air entrainment zone
- Sample size: ~500 mL in clean HDPE container
- Hold 30 min for de-aeration before testing

---

## 5. Hold Point 3 — Final Batch (HP-3)

See [PAL-21-QC-003 — Finished Product QC Protocol](/formulations/qc/PAL-21-QC-003_FINISHED_PRODUCT_QC.md)

Full finished product QC is conducted at HP-3 before release for filling.

---

## 6. In-Process Adjustment Guidelines

### 6.1 Viscosity Adjustment (Letdown)
- **Target final:** 100–110 KU (for roller application)
- **If too low (<95 KU):** Add HASE thickener pre-diluted 1:3 with water. Addition rate: 0.1% w/w per 2 KU increase. Mix 10 min after each addition.
- **If too high (>115 KU):** Add letdown water. Each 1% water reduces viscosity by ~3–5 KU. Mix 5 min, re-measure.
- **Record all adjustments** on the BMR with before/after values.

### 6.2 pH Adjustment
- **Target:** 8.5–9.0
- **If too low (<8.2):** Add 25% ammonia solution in 0.05% increments. Mix 5 min. Re-check. Max allowable: 0.3% total ammonia in formula.
- **If too high (>9.2):** Accept up to 9.5 (risk: ammonia odour, VOC exceedance). Above 9.5, add small water letdown + re-test.

### 6.3 Foam Control
- **If foam layer >5 mm:** Add 0.05% defoamer. Mix 5 min. Re-check. Max 0.5% total defoamer.

---

## 7. In-Process QC Record

All HP-1 and HP-2 results must be recorded in the BMR (see [PAL-21-QC-004 BMR Template](/formulations/qc/PAL-21-QC-004_BMR_TEMPLATE.md)). The QC operator signs each hold point before the batch proceeds.

---

## Revision History

| Rev | Date | Author | Change |
|---|---|---|---|
| 1.0 | 2026-05-28 | CTO | Initial release |
