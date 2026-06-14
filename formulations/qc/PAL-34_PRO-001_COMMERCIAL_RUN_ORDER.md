# Commercial Batch Run Order — Stage 3 (500 L)

**Document code:** PAL-34-PRO-001
**Issue:** [PAL-34](/PAL/issues/PAL-34)
**Parent:** [PAL-22](/PAL/issues/PAL-22)
**Date:** 2026-05-29
**Author:** CTO
**Status:** Ready for CEO go/no-go

---

## Batch Sequence

| Order | Batch ID | Base Type | Volume | Est. Weight | Est. Duration | Purpose |
|---|---|---|---|---|---|---|
| 1 | C-01 | White (Base 1) | 500 L | 675 kg | 4 hr | First commercial batch — most validated |
| 2 | C-02 | Medium (Base 3) | 500 L | 650 kg | 4 hr | Medium base at commercial scale |
| 3 | C-03 | Deep (Base 21) | 500 L | 625 kg | 4 hr | Deep base — least validated at scale |
| 4 | C-04 | White (Base 1) | 500 L | 675 kg | 4 hr | Repeatability — White repeat |
| 5 | C-05 | Medium (Base 3) | 500 L | 650 kg | 4 hr | Repeatability — Medium repeat |

**Total:** 5 batches, 2,500 L, ~3,275 kg raw material, ~20 production hours

---

## Process Parameters (All Validated)

| Parameter | White Base | Medium Base | Deep Base |
|---|---|---|---|
| Disperser RPM (300 mm impeller) | ~1,400 | ~1,400 | ~1,400 |
| Tip speed (m/s) | 22 | 22 | 22 |
| Grind time (min) | ~27 | ~27 | ~24 |
| Grind max temp (°C) | <50 | <50 | <50 |
| Letdown RPM | 300-400 | 300-400 | 300-400 |
| Emulsion addition (min) | ≥10 | ≥10 | ≥10 |
| Homogenisation (min) | ≥15 | ≥15 | ≥15 |
| De-aeration (min) | 30 | 30 | 30 |
| Total batch time (hr) | ~3.5-4 | ~3.5-4 | ~3.5-4 |

Grind time source: PAL-51 mean 22.7 min at 200 L, scaled to 500 L by exponent 0.20 (= ~27 min).

---

## Raw Material Estimate (All 5 Batches)

| Material | Unit | C-01 White | C-02 Medium | C-03 Deep | C-04 White | C-05 Medium | Total | Est. Inventory Required |
|---|---|---|---|---|---|---|---|---|
| Water (DM) | kg | 192 | 201 | 221 | 192 | 201 | 1,007 | 1,100 L |
| TiO₂ (Rutile) | kg | 142 | 78 | 31 | 142 | 78 | 471 | 500 kg |
| CaCO₃ | kg | 91 | 130 | 138 | 91 | 130 | 580 | 600 kg |
| Talc | kg | 34 | 33 | 31 | 34 | 33 | 165 | 200 kg |
| Kaolin | kg | 27 | 26 | 25 | 27 | 26 | 131 | 150 kg |
| Styrene-Acrylic Emulsion | kg | 162 | 156 | 150 | 162 | 156 | 786 | 800 kg |
| Texanol | kg | 12 | 12 | 11 | 12 | 12 | 59 | 70 kg |
| HASE | kg | 3.4 | 3.9 | 4.4 | 3.4 | 3.9 | 19 | 25 kg |
| HEC | kg | 1.4 | 1.3 | 1.9 | 1.4 | 1.3 | 7.3 | 10 kg |
| Dispersant | kg | 3.4 | 2.6 | 1.9 | 3.4 | 2.6 | 13.9 | 20 kg |
| Defoamer | kg | 2.7 | 2.7 | 2.5 | 2.7 | 2.7 | 13.3 | 20 kg |
| Bentonite | kg | 0.7 | 0.7 | 0.6 | 0.7 | 0.7 | 3.4 | 5 kg |
| Ammonia (25%) | kg | 1.7 | 1.6 | 1.6 | 1.7 | 1.6 | 8.2 | 10 kg |
| Biocide | kg | 1.2 | 1.2 | 1.1 | 1.2 | 1.2 | 5.9 | 10 kg |
| Wetting Agent | kg | 1.0 | 0.7 | 0.6 | 1.0 | 0.7 | 4.0 | 5 kg |
| Transparent Iron Oxide | kg | 0 | 0 | 3.1 | 0 | 0 | 3.1 | 5 kg |
| **Total per batch** | **kg** | **675** | **650** | **625** | **675** | **650** | **3,275** | |

**Note:** All materials available from PAL-51 pre-qualified suppliers. Emulsion and TiO₂ are the critical-path items — verify 4-6 week lead time.

---

## QC Testing Plan

| Hold Point | Stage | Tests | Est. Duration |
|---|---|---|---|
| HP-1 | After grind | Hegman, Temperature, Visual | 5 min |
| HP-2 | After letdown | pH, Viscosity (preliminary), Temperature, Foam | 15 min |
| HP-3 | Final QC | Full panel (11 tests + stability samples) | 30 min |

### Accelerated Aging Samples
- Every batch: 2 × 250 mL HDPE bottles to 50°C oven
- Reference: PAL-51 aging protocol (4 wk at 50°C)
- Total: 10 samples (5 batches × 2)

### Retain Samples
- Every batch: 1 L composite sample in sealed HDPE container
- Store at ambient in QC retain area

---

## Success Criteria

| Criterion | Target | Source |
|---|---|---|
| All CQAs within spec | 100% | PAL-21-QC-003 |
| Batch yield | ≥97% | PAL-34 SOP §10 |
| Viscosity batch-to-batch | ≤±3 KU | PAL-34 SOP §10 |
| Hegman | ≥6 | PAL-34 SOP §10 |
| Accelerated aging pass | 4 wk at 50°C | PAL-21-QC-006 |

---

## Pre-Requisites Checklist

- [ ] Raw materials ordered and received (all 17 items, single lots preferred)
- [ ] Raw materials QC-released per PAL-21-QC-001
- [ ] Equipment pre-maintenance per PAL-MNT SOPs
- [ ] Operators trained per PAL-21-QC-005
- [ ] QC instruments calibrated per PAL-29 schedule
- [ ] BMR templates printed (5 × PAL-34-BMR-CM-001, one per batch)
- [ ] Validation data sheet prepared
- [ ] Accelerated aging oven available (50°C)
- [ ] Retain containers and labels ready

**Prerequisite status:** All pre-requisites verified as PASS during PAL-51 execution (PAL-51-PREREQ-001). Re-verify calibration dates before C-01 start.

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| First 500 L batch off-spec | Medium | High | C-01 is White Base (most validated data); conservative grind-to-Hegman approach |
| Bentonite clay interaction | Low | Medium | Not tested in PAL-51 (not needed at 200 L). Monitor settling in finished product |
| Emulsion shear at 500 L | Low | Medium | Larger impeller but same tip speed (22 m/s). Monitor letdown temperature |
| Raw material shortage | Low | High | Order minimum 5-batch quantities of all items before start |
| Hegman reproducibility | Medium | Medium | PAL-51 Cpk = 1.26 (below 1.33 target). Review disperser blade condition |

---

## Go/No-Go Gates

| Gate | Criteria | Verifier |
|---|---|---|
| G1: Strategic approval | CEO confirms commercial batch investment | CEO |
| G2: Raw material availability | All lots received and QC-released | Supply Chain / QC |
| G3: Equipment readiness | Pre-maintenance completed, no open findings | Maintenance |
| G4: Operator availability | 2 trained operators per shift available | Production |

**Current status:** G2-G4 pre-verified during PAL-51. G1 pending CEO decision.

---

## References

| Document | Code |
|---|---|
| Scale-Up Validation Report | PAL-33 (rev 3) |
| Commercial Production SOP | PAL-34-SOP-001 (rev 2) |
| Commercial BMR Template | PAL-34-BMR-CM-001 (rev 2) |
| White Base Master Formulation | PAL-34-MF-WH-001 |
| Medium Base Master Formulation | PAL-34-MF-MD-001 |
| Deep Base Master Formulation | PAL-34-MF-DP-001 |
| Validation Prerequisites | PAL-51-PREREQ-001 |
| Validation Data (White, 10 batches) | PAL-51-QC-010 |
| Plant Layout & Equipment Specs | PAL-68 |

---

**End of Commercial Run Order**
