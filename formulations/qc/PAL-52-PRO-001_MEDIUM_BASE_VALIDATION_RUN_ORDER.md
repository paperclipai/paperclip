# Production Run Order — Medium Base Validation Batches

**Issue:** [PAL-52](/PAL/issues/PAL-52)
**Document code:** PAL-52-PRO-001
**Date:** 2026-05-29
**Author:** CTO
**Status:** Ready for execution

---

## 1. Run Summary

Execute 5 validation batches of Medium Base (Base 3) at 200 L pilot scale.

| Batch | Base Type | Size | Theoretical Weight | BMR Document |
|---|---|---|---|---|
| VB-011 | Medium | 200 L | 260 kg | [PAL-33-QC-009](/formulations/qc/PAL-33-QC-009_BMR_VALIDATION_MEDIUM_200L.md) |
| VB-012 | Medium | 200 L | 260 kg | [PAL-33-QC-009](/formulations/qc/PAL-33-QC-009_BMR_VALIDATION_MEDIUM_200L.md) |
| VB-013 | Medium | 200 L | 260 kg | [PAL-33-QC-009](/formulations/qc/PAL-33-QC-009_BMR_VALIDATION_MEDIUM_200L.md) |
| VB-014 | Medium | 200 L | 260 kg | [PAL-33-QC-009](/formulations/qc/PAL-33-QC-009_BMR_VALIDATION_MEDIUM_200L.md) |
| VB-015 | Medium | 200 L | 260 kg | [PAL-33-QC-009](/formulations/qc/PAL-33-QC-009_BMR_VALIDATION_MEDIUM_200L.md) |

**Total:** 1,000 L | 1,300 kg raw materials

---

## 2. Schedule

- Recommended execution order: VB-011 → VB-012 → VB-013 → VB-014 → VB-015
- Target: 1 batch per shift (3.5–4 hr per batch)
- Allow minimum 30 min between batches for cleaning and setup

---

## 3. Prerequisites Gate

**All 8 prerequisites (P1–P8) must be signed off before VB-011 starts.**

Current status:

| # | Prerequisite | Status | Responsible |
|---|---|---|---|
| P1 | QC instruments calibrated | PENDING | QC Supervisor |
| P2 | BMR templates printed | PENDING | Production Supervisor |
| P3 | Single lots pre-qualified and QC released | PENDING | QC Supervisor |
| P4 | Operators trained per PAL-21-QC-005 | PENDING | QC Supervisor |
| P5 | Equipment pre-maintenance complete | PENDING | Maintenance |
| P6 | Validation data sheet ready | PENDING | QC Supervisor |
| P7 | Retain sample containers and labels ready | PENDING | Production |
| P8 | Accelerated aging oven available (50°C) | PENDING | QC Supervisor |

---

## 4. Raw Material Requirements (5 Batches)

Same single-lot materials across all 5 batches. Verify lot numbers match White Base validation lots.

| # | Raw Material | Per Batch (kg) | ×5 (kg) | Function |
|---|---|---|---|---|
| 1 | Water (DM) — grind | 90.00 | 450.0 | Carrier |
| 2 | Dispersant (Polyacrylate) | 1.30 | 6.5 | Pigment wetting |
| 3 | Defoamer (grind) | 0.55 | 2.75 | Foam control |
| 4 | Biocide (BIT/MIT) | 0.36 | 1.8 | Preservation |
| 5 | TiO₂ — Rutile | 9.00 | 45.0 | Opacity |
| 6 | CaCO₃ (Ground) | 38.00 | 190.0 | Extender |
| 7 | Talc (Micro-fine) | 10.00 | 50.0 | Extender |
| 8 | Kaolin (China Clay) | 8.00 | 40.0 | Film structure |
| 9 | Styrene-Acrylic Emulsion (50%) | 42.00 | 210.0 | Binder |
| 10 | Texanol (Coalescent) | 2.00 | 10.0 | Coalescent |
| 11 | HASE Thickener | 1.98 | 9.9 | Viscosity control |
| 12 | Ammonia (25%) | 0.04 | 0.2 | pH adjuster |
| 13 | Defoamer (letdown top-up) | 0.10 | 0.5 | Foam control |
| 14 | Water (letdown) | ~40.67 | ~203.35 | To target weight |
| | **Total** | **~260.00** | **~1,300.0** | |

---

## 5. Hold Point Summary

### HP-1 (After Grind)
- Hegman fineness ≥ 6
- Temperature < 50°C
- Visual: smooth paste, no lumps
- **Pass → proceed to letdown | Fail → re-grind (max 1 attempt)**

### HP-2 (After Letdown, Before Final Water)
- pH: 8.5–9.0
- Viscosity (KU): 95–110
- Foam: < 5 mm
- **Pass → proceed to final water & homogenisation | Fail → adjust & re-test**

### HP-3 (Final QC — After 30 min de-aeration)
See Section D of BMR for full panel (10 tests, 3 readings each for viscosity/pH)

---

## 6. Process Parameters (Hold Constant for All 5 Batches)

| Parameter | Setting | Tolerance |
|---|---|---|
| Disperser speed | 2100 RPM | ±100 RPM |
| Grind time | 20 min | ±5 min |
| Grind temperature | < 50°C | Max |
| Letdown speed | 650 RPM | ±150 RPM |
| Emulsion addition | ≥ 8 min | Slow, consistent |
| De-aeration time | 30 min | Fixed |
| Final temperature | < 40°C | Max |

---

## 7. Samples Per Batch

| Sample | Container | Volume | Storage | Retention |
|---|---|---|---|---|
| Retain | 250 mL HDPE, labelled VB-0XX-R | 250 mL | 25°C, dark | 12 months |
| Accelerated aging | 250 mL HDPE, labelled VB-0XX-A | 250 mL | 50°C oven | 4 weeks |

**Label format:** `PAL-MD-200-VAL-001 / VB-0XX / {R|A} / YYYY-MM-DD`

---

## 8. Deliverables per Batch

- [ ] Completed BMR (signed by all roles)
- [ ] QC data transferred to validation data sheet within 24 hr
- [ ] Retain sample labelled and stored
- [ ] Accelerated aging sample placed in 50°C oven
- [ ] Deviation report (if any)

---

**End of Production Run Order**

*Template prepared: 2026-05-29 | Author: CTO*
