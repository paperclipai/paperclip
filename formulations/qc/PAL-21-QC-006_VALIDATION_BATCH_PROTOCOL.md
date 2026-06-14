# Validation Batch Protocol — Process Capability (Cpk) Study

**Document code:** PAL-21-QC-006
**Date:** 2026-05-28
**Author:** CTO
**Status:** Plan — ready for execution

---

## 1. Purpose

This protocol defines the plan to run 20 validation batches (10 White Base, 5 Medium Base, 5 Deep Base) to:
1. Confirm the manufacturing process is stable and in control
2. Calculate process capability indices (Cpk) for critical quality attributes
3. Validate that the QC pass/fail limits are achievable in production
4. Identify any process adjustments needed before commercial production

**Reference:** [A.5 Quality System Implementation Plan (Phase 1)](/formulations/PAL-15_PAINT_BASE_KNOWLEDGE.md#a5-quality-system-implementation-plan-phase-1)

---

## 2. Batch Plan

| Base Type | Number of Batches | Batch Size | Purpose |
|---|---|---|---|
| White Base (Base 1) | 10 | 200 L | Primary Cpk assessment — highest value product |
| Medium Base (Base 3) | 5 | 200 L | Confirm transferability of process settings |
| Deep Base (Base 21) | 5 | 200 L | Confirm transferability (different rheology profile) |
| **Total** | **20** | **200 L** | |

**Rationale for 200 L batch size:** Pilot scale (trial-production crossover). Large enough to expose scale-up effects, small enough to limit material loss if batches fail.

---

## 3. Critical Quality Attributes (CQAs) for Cpk

| CQA | Specification (USL/LSL) | Target | Measurement | Data Points per Batch |
|---|---|---|---|---|
| Viscosity (KU) | LSL 100, USL 110 | 105 KU | Stormer | 3 (beginning, middle, end of fill) |
| pH | LSL 8.5, USL 9.0 | 8.75 | pH meter | 3 |
| Hegman Fineness | LSL 6 (no USL) | ≥ 7 | Hegman gauge | 2 |
| Density (g/mL) — White | LSL 1.30, USL 1.40 | 1.35 | Density cup | 2 |
| Density (g/mL) — Medium | LSL 1.25, USL 1.35 | 1.30 | Density cup | 2 |
| Density (g/mL) — Deep | LSL 1.20, USL 1.30 | 1.25 | Density cup | 2 |
| Opacity (%) — White | LSL 96 (no USL) | >97% | Contrast ratio | 2 |
| Opacity (%) — Medium | LSL 94 (no USL) | >95% | Contrast ratio | 2 |
| Opacity (%) — Deep | LSL 90 (no USL) | >92% | Contrast ratio | 2 |
| Touch dry time (min) | USL 30 | <20 min | Cotton ball | 1 |

---

## 4. Cpk Calculation Method

### 4.1 Formulas

For two-sided specifications (viscosity, pH, density):

```
Cpk = min(Cpku, Cpkl)

Cpku = (USL − μ) / (3σ)
Cpkl = (μ − LSL) / (3σ)
```

For one-sided with lower limit only (Heqman, opacity):

```
Cpk = (μ − LSL) / (3σ)
```

For one-sided with upper limit only (touch dry time):

```
Cpk = (USL − μ) / (3σ)
```

### 4.2 Acceptance Criteria

| Cpk Value | Process Capability | Action |
|---|---|---|
| ≥ 1.67 | Excellent | No action needed |
| 1.33 – 1.66 | Good — capable | Maintain controls |
| 1.00 – 1.32 | Marginal — needs improvement | Investigate variability sources, tighten process control |
| < 1.00 | Poor — not capable | Process redesign required before commercial production |

**Target for all CQAs:** Cpk ≥ 1.33 (industry standard for paint manufacturing)

### 4.3 Sample Size Consideration

With n = 10 (White Base), the 95% confidence interval for Cpk is approximately ±0.35. This is acceptable for initial process capability assessment. Plan to re-calculate after 50 commercial batches for tighter confidence.

---

## 5. Batch Execution Protocol

### 5.1 Before Each Batch
- [ ] Verify all raw materials have passed incoming QC (PAL-21-QC-001)
- [ ] Verify QC instruments calibrated (calibration log checked)
- [ ] Verify BMR template (PAL-21-QC-004) printed and ready
- [ ] Verify equipment pre-start checklist done (bearing grease, shaft seal, RPM calibration)
- [ ] Pre-weigh all raw materials (within ±0.5% of target)

### 5.2 During Batch
- [ ] Follow standard manufacturing process (two-stage: grind → letdown)
- [ ] Record all process parameters per BMR
- [ ] QC holds at HP-1, HP-2, HP-3 per PAL-21-QC-002
- [ ] Document any process deviations — no hiding issues
- [ ] Take photos of Hegman drawdown for record

### 5.3 After Batch
- [ ] Complete all BMR sections
- [ ] Submit BMR to QC within 24 hr
- [ ] One 250 mL retain sample per batch (labelled, sealed, stored at 25°C, retained 12 months)
- [ ] One 250 mL accelerated aging sample (50°C, 4-week monitoring)

### 5.4 Process Parameters to Hold Constant

| Parameter | Setting | Rationale |
|---|---|---|
| Disperser speed | 2000 RPM | Mid-range of 1500–2500 spec |
| Grind time | 20 min | Mid-range of spec |
| Letdown speed | 650 RPM | Mid-range of spec |
| Emulsion addition rate | 10 min per 200 L | Slow, consistent |
| Mix temperature at letdown | 25°C ± 5°C | Avoid thermal shock |
| De-aeration time | 30 min | Before QC testing |

---

## 6. Data Recording Template

Each batch's QC results recorded in the validation data sheet:

```
Validation Batch #: VB-001
Base Type: White
Date: ________

QC Results:
Viscosity (KU): ____, ____, ____  | Avg: ____
pH: ____, ____, ____              | Avg: ____
Hegman: ____, ____                | Avg: ____
Density (g/mL): ____, ____        | Avg: ____
Opacity (%): ____, ____           | Avg: ____
Touch dry (min): ____             | Avg: ____

Process Parameters:
Disperser RPM: ____   Grind time: ____
Grind peak temp: ____   Letdown RPM: ____
Emulsion addition time: ____
Yield (%): ____

Deviations: ______________________________
QC Disposition: [ ] RELEASE [ ] HOLD [ ] REJECT
```

---

## 7. Statistical Analysis Plan

After all 20 batches complete:

1. **Descriptive statistics:** Mean, median, range, standard deviation for each CQA per base type
2. **Normality test:** Anderson-Darling or Shapiro-Wilk (if n ≥ 10); for n < 10, use visual normality assessment
3. **Control charts:** X̄-R charts for each CQA per base type
4. **Cpk calculation** per section 4 above
5. **Capability report:** Document with recommendations

---

## 8. Resources Required

| Resource | Quantity | Cost Estimate (INR) |
|---|---|---|
| Raw materials for 20 × 200 L batches | ~4,000 L total | ~₹4,00,000 |
| QC technician time | 40 hr (2 hr per batch) | Included in salary |
| Production operator time | 100 hr (5 hr per batch) | Included in salary |
| QC instrument calibration | Pre-study check | ₹5,000 |
| Statistical software (or Excel) | 1 license | Existing |
| Retain sample storage | 40 bottles + rack | ₹2,000 |
| **Total estimated study cost** | | **~₹4,07,000** |

---

## 9. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Validation batches fail Cpk < 1.0 | Medium | High — delays commercial launch | Design space covers >1.33 target; marginal batches still acceptable for learning |
| Raw material lot variation | Medium | Medium | Use single pre-qualified lot for all 20 batches |
| Equipment breakdown | Low | High | Pre-maintenance check before starting; spare parts on hand |
| Operator error in data recording | Medium | Low | QC supervisor verifies all entries; electronic backup of critical data |
| Insufficient data for Cpk (n too small) | High (for Medium/Deep n=5) | Low | Combine base types for pooled estimate; flag as limitation |

---

## 10. Deliverables

1. Completed 20 BMRs (originals to QC archive)
2. Validation data sheet (all QC results in single spreadsheet)
3. Control charts (X̄-R) for each CQA
4. Cpk report with pass/fail assessment per CQA
5. Recommendations for spec limit adjustments (if any)
6. Signed Validation Report approving process for commercial production (or listing required changes)

---

## Revision History

| Rev | Date | Author | Change |
|---|---|---|---|
| 1.0 | 2026-05-28 | CTO | Initial release |
