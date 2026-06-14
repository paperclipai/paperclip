# Trial Batch Manufacturing Record — T-01: White Base (200 L)

**Document code:** PAL-33-QC-006
**Date:** 2026-05-28
**Author:** CTO
**Status:** Final — calibrated from Pilot stage data
**Applies to:** Trial batch T-01 — White Base (Base 1) at 200 L scale
**Derived from:** PAL-32 Pilot batch P-04 (50 L White) — scaled ×4.0 with HASE +10%, defoamer +20%

---

## Section A — Header

| Field | Entry |
|---|---|
| **BMR Number** | BMR-T01 |
| **Base Type** | [X] White [ ] Medium [ ] Deep [ ] Clear |
| **Product Code** | PC-WHITE-TRIAL-001 |
| **Batch Size (L)** | 200 |
| **Theoretical Batch Weight (kg)** | ~270 (based on target density 1.35 g/mL) |
| **Date** | |
| **Shift** | [ ] Day [ ] Afternoon [ ] Night |
| **Production Order #** | |
| **BMR Revision** | 1.0 |

---

## Section B — Raw Material Weighing — White Base (200 L)

**Calibrated from PAL-32 Pilot P-04 (50 L White) data.**

Scale-up adjustments applied:
- Defoamer: ×4.8 from pilot (+20% — deeper vortex at 200 L entrains more air)
- Thickener (HASE): ×4.4 from pilot (+10% — higher shear history at scale)
- Grind time: scaled by (vol ratio)^0.3 ≈ 1.5×
- Total batch weight: ~200 kg (density ~1.00 kg/L, lower than commercial due to higher water fraction at letdown)

| # | Raw Material | Specified Weight (kg) | Pilot P-04 × Factor | Lot/Batch # | Checked By |
|---|---|---|---|---|---|
| 1 | Water (DM) — grind | 80.00 | 20.00 × 4.0 | | |
| 2 | Dispersant (Polyacrylate) | 1.20 | 0.30 × 4.0 | | |
| 3 | Wetting Agent (Non-ionic) | 0.40 | 0.10 × 4.0 | | |
| 4 | Defoamer (grind portion) | 0.60 | 0.125 × 4.8 | | |
| 5 | Biocide (BIT/MIT) | 0.36 | 0.09 × 4.0 | | |
| 6 | TiO₂ — Rutile | 18.00 | 4.50 × 4.0 | | |
| 7 | CaCO₃ (Ground) | 32.00 | 8.00 × 4.0 | | |
| 8 | Talc (Micro-fine) | 8.00 | 2.00 × 4.0 | | |
| 9 | Kaolin (China Clay) | 8.00 | 2.00 × 4.0 | | |
| 10 | Styrene-Acrylic Emulsion (50%) | 35.00 | 8.75 × 4.0 | | |
| 11 | Texanol (Coalescent) | 1.80 | 0.45 × 4.0 | | |
| 12 | HASE Thickener | 2.42 | 0.55 × 4.4 | | |
| 13 | Ammonia (25%) | 0.05 | 0.012 × 4.2 | | |
| 14 | Defoamer (letdown top-up) | 0.10 | — | | |
| 15 | Water (letdown) | 20.00 | 5.00 × 4.0 | | |
| | **Total** | **~207.93** | | | |

**Weighing Operator:** ____________________ **Date:** ________

**Check-Weigh by Supervisor:** ________________ **Date:** ________

**RM QC Release status verified (all lots released):** [ ] Yes [ ] No — if No, attach deviation note

---

## Section C — Manufacturing Process Log

### Stage 1: Grind (High-Speed Dispersion)

**Equipment:** 20 HP production disperser, 200 mm impeller
**Target tip speed:** 22 m/s → ~2100 RPM (RPM = (22 × 60) / (π × 0.20))

| Parameter | Spec | Actual | Time | Operator |
|---|---|---|---|---|
| Disperser RPM | 2000–2200 (target: 2100) | | | |
| Tip speed (m/s) | 20–25 (target: 22) | | | |
| Start time | | | | |
| Pigment addition start | | | | |
| Pigment addition complete | | | | |
| Grind time (min) | 20–30 (scaled from pilot) | | | |
| End time | | | | |

**Addition order verified:** [ ] Yes (Water → Dispersant → Defoamer → Biocide → TiO₂ → Extenders)

#### Hold-Time Sampling (T-01 only)
| Time Point | Sample ID | Hegman Reading | Notes |
|---|---|---|---|
| 5 min | | | |
| 10 min | | | |
| 15 min | | | |
| 20 min | | | |
| 25 min | | | |
| 30 min | | | |

### HOLD POINT HP-1 — Grind QC Check

| Test | Spec | Result | Pass/Fail | QC Operator | Date/Time |
|---|---|---|---|---|---|
| Hegman fineness | ≥ 6 | | | | |
| Temperature | < 50°C | | | | |
| Visual appearance | Smooth paste, no lumps | | | | |

**HP-1 Disposition:** [ ] PASS — proceed to Stage 2 [ ] FAIL — see deviation / re-grind

QC Supervisor: ___________________

---

### Stage 2: Letdown (Low-Speed Mixing)

**Equipment:** Low-speed anchor agitator, 200 L vessel
**Critical note:** Emulsion addition must be slow and stream-wise. At 200 L, minimum addition time: 8–10 min.

| Parameter | Spec | Actual | Time | Operator |
|---|---|---|---|---|
| Mixer RPM | 500–800 | | | |
| Start time | | | | |
| Emulsion — start addition | | | | |
| Emulsion — addition complete | | | | Min addition: ≥ 8 min |
| Emulsion addition rate | Slow, stream-wise | | | |
| Texanol pre-blend added | | | | |
| HASE pre-dissolved (1:3 with water) added | | | | |
| Ammonia added | | | | |
| Water letdown added | to target weight (270 kg) | | | |
| Homogenisation time | 15 min (longer at scale) | | | |
| End time | | | | |
| Defoamer top-up (if needed) | | | | |

### HOLD POINT HP-2 — Preliminary QC

| Test | Spec | Result | Pass/Fail | QC Operator | Date/Time |
|---|---|---|---|---|---|
| pH | 8.5–9.0 | | | | |
| Viscosity (KU) — preliminary | 95–110 | | | | |
| Foam level | <5 mm | | | | |

**HP-2 Disposition:** [ ] PASS — proceed [ ] FAIL — adjust & re-test (see §5 of PAL-21-QC-002)

QC Supervisor: ___________________

---

## Section D — Final QC (HP-3)

| # | Test | Spec | Result | Pass/Fail | Operator | Date/Time |
|---|---|---|---|---|---|---|
| 1 | Viscosity (KU) | 100–110 KU | | | | |
| 2 | pH | 8.5–9.0 | | | | |
| 3 | Hegman Fineness | ≥ 6 | | | | |
| 4 | Density (g/mL) | 1.30–1.40 | | | | |
| 5 | Opacity (Contrast Ratio %) | ≥ 96% | | | | |
| 6 | Gloss 60° | <5 | | | | |
| 7 | Touch dry (min) | <30 | | | | |
| 8 | Hard dry (hr) | <4 | | | | |
| 9 | Odour | Mild, acceptable | | | | |
| 10 | Colour (visual) | Matches reference | | | | |

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
| Theoretical batch weight (kg) | 270.00 |
| Actual batch weight (kg) | |
| Yield (%) = (Actual / Theoretical) × 100 | |
| Target yield | ≥ 95% |
| Loss / discrepancy (kg) | |
| Root cause of loss (if >3%) | |
| Waste generated (L) | |
| Waste disposal method | |

---

## Section F — Scale-Up Observations (Trial-Specific)

| Observation | Value | Comparison to Pilot |
|---|---|---|
| Actual grind time to reach Hegman ≥ 6 | | |
| Temperature rise during grind (°C) | | |
| Viscosity shift from HP-2 to HP-3 (KU) | | |
| Visual foam behaviour | | |
| Settling observation after 30 min hold | | |
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
| CTO / QA Release (Trial batch) | | | |

---

## Section I — Document Control

| Field | Value |
|---|---|
| BMR Number | BMR-T01 |
| Date completed | |
| Archived location | |
| Retention period | 5 years from batch date |

---

## Revision History

| Rev | Date | Author | Change |
|---|---|---|---|
| 1.0 | 2026-05-28 | CTO | Initial trial template — White Base, 200 L |
