# Validation Batch Manufacturing Record — White Base (200 L)

**Document code:** PAL-51-QC-009
**Issue:** [PAL-51](/PAL/issues/PAL-51)
**Parent plan:** [PAL-40](/PAL/issues/PAL-40#document-plan)
**Protocol:** [PAL-21-QC-006](/PAL/issues/PAL-21#document-qc-validation-protocol)
**Date:** 2026-05-29
**Author:** CTO
**Status:** Final — for VB-001 through VB-010 execution
**Scale:** 200 L (validated from [PAL-34 master formulation](/formulations/PAL-34_MASTER_FORMULATION_WHITE_BASE.md) × 0.4)

---

## Instructions for Use

1. One BMR per batch. Complete every field. Do not leave blanks — mark N/A where not applicable.
2. All entries in blue/black ink. No pencil.
3. Corrections: single line through error, initial, date, and write correct value. No erasures or white-out.
4. Each operator signs and dates only the sections they perform.
5. QC hold points MUST be signed by QC operator before next stage proceeds.
6. Completed BMRs returned to QC office within 24 hr of batch completion.

---

## Section A — Header

| Field | Entry |
|---|---|
| **BMR Number** | VB-___ |
| **Base Type** | [X] White [ ] Medium [ ] Deep [ ] Clear |
| **Product Code** | PAL-WH-200-VB |
| **Batch Size (L)** | 200 |
| **Theoretical Batch Weight (kg)** | ~270 (at 1.35 g/mL) |
| **Date** | |
| **Shift** | [ ] Day [ ] Afternoon [ ] Night |
| **Production Order #** | |
| **BMR Revision** | 1.0 |

---

## Section B — Raw Material Weigh Sheet — White Base (200 L)

**Scale factor:** 0.4× from [PAL-34 master formulation](/formulations/PAL-34_MASTER_FORMULATION_WHITE_BASE.md) (500 L → 200 L)

**Pre-qualified single lot:** Per [PAL-51-PREREQ-001](/formulations/qc/PAL-51_PREREQUISITES_SIGN_OFF.md)

| # | Raw Material | Specified Weight (kg) | Tolerance (±kg) | Lot/Batch # | Actual Weight (kg) | Checked By |
|---|---|---|---|---|---|---|
| 1 | Water (DM) — grind | 55.36 | 0.28 | DM-2026-05-15 | | |
| 2 | Dispersant (Polyacrylate) | 1.36 | 0.01 | PA-2026-12 | | |
| 3 | Wetting Agent (Non-ionic) | 0.40 | 0.01 | NI-2026-08 | | |
| 4 | Defoamer (grind portion) | 0.80 | 0.01 | DF-2026-05 | | |
| 5 | Biocide (BIT/MIT) | 0.48 | 0.01 | BC-2026-03 | | |
| 6 | TiO₂ — Rutile | 56.72 | 0.28 | TR-2026-11 | | |
| 7 | CaCO₃ (Ground) | 36.44 | 0.18 | CC-2026-07 | | |
| 8 | Talc (Micro-fine) | 13.52 | 0.07 | TC-2026-04 | | |
| 9 | Kaolin (China Clay) | 10.80 | 0.05 | KL-2026-06 | | |
| 10 | Bentonite Clay | 0.28 | 0.01 | BT-2026-02 | | |
| 11 | Styrene-Acrylic Emulsion (50%) | 64.80 | 0.32 | SA-2026-09 | | |
| 12 | Texanol | 4.88 | 0.02 | TX-2026-05 | | |
| 13 | HASE Rheology Modifier | 1.36 | 0.01 | HS-2026-03 | | |
| 14 | HEC Rheology Modifier | 0.56 | 0.01 | HC-2026-04 | | |
| 15 | Ammonia (25%) | 0.68 | 0.01 | AM-2026-08 | | |
| 16 | Defoamer (letdown top-up) | 0.28 | 0.01 | DF-LD-2026-01 | | |
| 17 | Water (DM) — letdown | 21.40 | 0.11 | DM-2026-05-15 | | |
| | **Total** | **270.12** | | | | |

**Weighing Operator:** ____________________ **Date:** ________

**Check-Weigh by Supervisor:** ________________ **Date:** ________

**RM QC Release status verified (all lots released):** [ ] Yes [ ] No — if No, attach deviation note

---

## Section C — Manufacturing Process Log

### Stage 1: Grind (High-Speed Dispersion)

**Equipment:** 20 HP production disperser, 200 mm impeller
**Target tip speed:** 22 m/s → ~2100 RPM

| Parameter | Spec | Actual | Time | Operator |
|---|---|---|---|---|
| Disperser RPM | 2000–2200 (target: 2100) | | | |
| Tip speed (m/s) | 20–25 (target: 22) | | | |
| Start time | | | | |
| Water + additives charged | | | | |
| Pigment addition start | | | | |
| Pigment addition complete | | | | |
| Grind time (min) | 20–30 | | | |
| End time | | | | |

**Addition order verified:** [ ] Yes (Water → Dispersant → Defoamer → Biocide → TiO₂ → CaCO₃ → Talc → Kaolin → Bentonite)

#### Grind Progression

| Time (min) | RPM | Temperature (°C) | Hegman Reading | Observations |
|---|---|---|---|---|
| 0 | | | — | Start |
| 5 | | | | |
| 10 | | | | |
| 15 | | | | Check Hegman |
| 20 | | | | |
| 25 | | | | If needed |
| 30 | | | | Max |
| End | | | | |

### HOLD POINT HP-1 — Grind QC Check

| Test | Spec | Result | Pass/Fail | QC Operator | Date/Time |
|---|---|---|---|---|---|
| Hegman fineness | ≥ 6 | | | | |
| Temperature | < 50°C | | | | |
| Visual appearance | Smooth paste, no lumps | | | | |

**Addition order verified:** [ ] Yes [ ] No
**Disperser shutdown verified:** [ ] Yes

**HP-1 Disposition:** [ ] PASS — proceed to Stage 2 [ ] FAIL — see deviation / re-grind

QC Supervisor: ___________________

---

### Stage 2: Letdown — Transfer to Letdown Vessel

**Equipment:** Diaphragm transfer pump, 100 µm in-line bag filter

| Parameter | Spec | Actual |
|---|---|---|
| Transfer flow rate (L/min) | ~50 | |
| Filter inlet pressure (bar) | < 2.0 | |
| Flush water used (L) | 5–10 | |
| Heel left in grind vessel (L) | < 5 | |
| Transfer start time | | |
| Transfer end time | | |

### Stage 3: Letdown (Low-Speed Mixing)

**Equipment:** Anchor agitator, 200 L vessel
**Critical:** Emulsion addition must be slow and stream-wise. Minimum addition time: 8 min.

| Parameter | Spec | Actual | Time | Operator |
|---|---|---|---|---|
| Anchor RPM | 300–400 | | | |
| Start time | | | | |
| Emulsion — start addition | | | | |
| Emulsion — addition complete | | | | Min: ≥ 8 min |
| Emulsion addition rate | Slow, stream-wise | | | |
| Texanol added | | | | |
| HASE (pre-dissolved) added | | | | |
| HEC (pre-gel) added | | | | |
| Ammonia added (titrate to pH 8.5–9.0) | | | | |
| Water letdown added | to 270 kg target | | | |
| Homogenisation time (min) | ≥ 15 | | | |
| End time | | | | |
| Defoamer top-up (if needed) | | | | |

### HOLD POINT HP-2 — Preliminary QC

| Test | Spec | Result | Pass/Fail | QC Operator | Date/Time |
|---|---|---|---|---|---|
| pH | 8.5–9.0 | | | | |
| Viscosity (KU) — preliminary | 95–110 | | | | |
| Foam level | < 5 mm | | | | |
| Temperature | < 40°C | | | | |

**HP-2 Disposition:** [ ] PASS — proceed [ ] FAIL — adjust & re-test (per PAL-21-QC-002 §5)

QC Supervisor: ___________________

### Stage 4: De-aeration (Before Final QC)

| Parameter | Spec | Actual |
|---|---|---|
| Anchor RPM (reduced) | ~200 | |
| De-aeration time (min) | 30 | |
| Composite sample drawn? | Yes | [ ] Yes [ ] No |

---

## Section D — Final QC (HP-3) — Full Panel

| # | Test | Spec | Reading 1 | Reading 2 | Reading 3 | Mean | Pass/Fail | Operator |
|---|---|---|---|---|---|---|---|---|
| 1 | Viscosity (KU) | 100–110 | | | | | | |
| 2 | pH | 8.5–9.0 | | | | | | |
| 3 | Hegman Fineness | ≥ 6 | | | — | | | |
| 4 | Density (g/mL) | 1.30–1.40 | | | — | | | |
| 5 | Opacity (Contrast Ratio %) | ≥ 96% | | | — | | | |
| 6 | Gloss 60° | < 5 | | | — | | | |
| 7 | Touch dry (min) | < 30 | | | — | | | |
| 8 | Hard dry (hr) | < 4 | | | — | | | |
| 9 | Odour | Mild, acceptable | | | — | | | |
| 10 | Colour (visual) | Matches reference | | | — | | | |

**Scrub resistance:** [ ] Tested — see separate report [ ] N/A (per schedule)
**Heat stability (50°C, 4 wk):** [ ] Started — sample dated ________ [ ] N/A

### Final Disposition

**HP-3 Disposition:** [ ] RELEASE [ ] HOLD [ ] REWORK [ ] REJECT

**QC Supervisor:** ____________________ **Date:** ________ **Time:** ________

**If HOLD/REWORK/REJECT — Deviation Reference #:** ________

---

## Section E — Batch Yield & Reconciliation

| Parameter | Value |
|---|---|
| Theoretical batch weight (kg) | 270.12 |
| Actual batch weight (kg) | |
| Yield (%) = (Actual / Theoretical) × 100 | |
| Target yield | ≥ 95% |
| Loss / discrepancy (kg) | |
| Root cause of loss (if > 3%) | |
| Waste generated (L) | |
| Waste disposal method | |

---

## Section F — Validation Observations

| Observation | Value | Notes |
|---|---|---|
| Actual grind time to reach Hegman ≥ 6 (min) | | |
| Peak temperature during grind (°C) | | |
| Viscosity shift HP-2 → HP-3 (KU) | | |
| Foam behaviour during letdown | | |
| Settling observation after 30 min hold | | |
| Filter pressure trend | | |
| Yield % | | |

---

## Section G — Deviations and Comments

| # | Description | Raised By | Date | QC Sign-off |
|---|---|---|---|---|
| | | | | |
| | | | | |
| | | | | |

---

## Section H — Final Approvals

| Role | Name | Signature | Date |
|---|---|---|---|
| Production Operator | | | |
| Production Supervisor | | | |
| QC Technician | | | |
| QC Supervisor | | | |
| CTO / QA Release (Validation batch) | | | |

---

## Section I — Document Control

| Field | Value |
|---|---|
| BMR Number | VB-___ |
| Date completed | |
| Archived location | |
| Retention period | 5 years from batch date |

---

## Section J — Retain Sample Record

| Sample ID | Volume | Container | Storage | Date | Technician |
|---|---|---|---|---|---|
| R-VB-___-250-1 | 250 mL | HDPE bottle | 25°C ambient | | |
| A-VB-___-250-1 | 250 mL | HDPE bottle | 50°C oven (accelerated aging) | | |

---

## Revision History

| Rev | Date | Author | Change |
|---|---|---|---|
| 1.0 | 2026-05-29 | CTO | Initial validation BMR template — White Base, 200 L, scaled from PAL-34 master formulation |
