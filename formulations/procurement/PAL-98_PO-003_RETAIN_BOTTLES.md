# Purchase Order: Retain Sample Containers and Labels

**PO Number:** PAL-PO-2026-003
**Date:** 2026-05-29
**Issue:** [PAL-98](/PAL/issues/PAL-98)
**Parent Plan:** [PAL-92](/PAL/issues/PAL-92#document-gate-release) — P7 Retain sample containers
**Billing Code:** commissioning-200l
**Ordered By:** CTO — [PAL Paints](/PAL/agents/cto)

---

## 1. Item Details

| Item | Specification | Qty | Unit Price | Est. Total |
|------|---------------|-----|------------|------------|
| 250 mL HDPE wide-mouth bottle with leak-proof screw cap | 250 mL, HDPE, white, wide mouth (≥40 mm neck), screw cap with seal ring, leak-proof | 50 | ₹28–34 | ₹1,400–1,700 |
| Pre-printed adhesive labels with variable data | 2" × 3" (50 mm × 75 mm), white paper stock, permanent adhesive, digital variable-data print | 50 | ₹2–6 | ₹100–300 |
| **Total** | | | | **₹1,500–2,000** |

**Note:** Order 50 units of each (10 spare) — 40 for the 20-batch validation, 10 for spares/replacements.

### 1.1 Bottle Specification

| Parameter | Requirement |
|-----------|-------------|
| Material | Virgin HDPE, food/pharma grade |
| Capacity | 250 mL (overflow ≥ 300 mL) |
| Neck finish | Wide mouth (≥ 40 mm inner diameter) for easy filling and cleaning |
| Closure | Screw cap with integral seal ring, leak-proof |
| Color | White (natural) |
| Weight | 20–25 g |
| Chemical resistance | Resistant to water-based paint formulations (pH 7–9), solvents (Texanol), and ammonia (25%) |
| Temperature range | 0–50°C (ambient and aging oven storage) |
| Standards | IS 9845 / BIS certified for food-grade HDPE |

### 1.2 Label Specification

| Parameter | Requirement |
|-----------|-------------|
| Size | 50 mm × 75 mm (2" × 3") |
| Material | White matte paper stock, 80–90 GSM, permanent acrylic adhesive |
| Print method | Digital variable-data printing |
| Quantity | 50 labels (40 + 10 spares) |
| Design | See §4 — Label Content & Variable Data Map |

---

## 2. Commercial Terms

| Term | Detail |
|------|--------|
| Price Basis | Inclusive of all taxes, delivered |
| Payment Terms | 100% advance (small-value purchase) — UPI / NEFT / credit card |
| GST | 18% (IGST/CGST+SGST as applicable) |
| MOQ | See supplier notes below |
| Delivery | Within 3–7 days of order |
| Inspection | Visual check: bottle integrity, cap seal, label adhesion, print legibility |
| Sample | Request physical sample before bulk order if supplier offers |

---

## 3. Recommended Suppliers

### 3.1 Bottles

#### Primary: Patco Pharmaceuticals Pvt. Ltd. (Online)
- **Product:** 250 mL White HDPE Empty Bottle with Screw Cap
- **URL:** https://patcopharma.com/products/250ml-white-hdpe-empty-bottle-for-secure-storage
- **Price:** ₹1,699 for 50 bottles (≈₹34/bottle)
- **MOQ:** 50 bottles — fits our requirement exactly
- **Stock:** In stock, ships within 2 days
- **Material:** 100% virgin food-grade HDPE with 43 mm neck, screw cap and wad included
- **Contact:** Online order via website; WhatsApp +91-8050066862

#### Backup: Sri Ram Plastic (Ulhasnagar, Maharashtra)
- **Product:** 250 mL Wide Mouth HDPE Bottle
- **Contact:** IndiaMART listing — inquire for 50-unit pricing
- **Price:** ~₹6.70/piece at wholesale; negotiate for 50-unit lot
- **Notes:** Local Maharashtra supplier; can arrange direct pickup if plant is within driving distance

### 3.2 Labels

#### Primary: Elite Printing And Packaging (Noida)
- **Product:** Variable Data Labels — white paper, custom size, variable text
- **Price:** ₹0.50/label + setup ~₹200–300 for first order
- **MOQ:** No stated minimum; small batches accepted
- **Contact:** A-39, Sector-65, Noida — 201301
- **Data format:** Supply CSV with 40 rows (batch number, date, base type, material code, R/A suffix)

#### Backup: Local print shop / Printo
- **Product:** Custom adhesive labels, 50 mm × 75 mm
- **Price:** ₹4–5/label at Printo (online: printopro.printo.in)
- **MOQ:** 50 labels
- **Turnaround:** 3–5 days

---

## 4. Label Content & Data Map

Each bottle receives a label with the following fields printed by variable-data process.

### 4.1 Static Content (same on every label)

```
PAL PAINTS — RETAIN SAMPLE
----------------------------
RETAIN — DO NOT USE
```

### 4.2 Variable Fields (per bottle)

| Field | Example | Notes |
|-------|---------|-------|
| Batch Number | VB-001 | Sequential: VB-001 to VB-020 |
| Sample Type | R | `R` = Retain (25°C), `A` = Accelerated Aging (50°C) |
| Base Type | WH | WH (White), MD (Medium), DP (Deep), CL (Clear) |
| Material Code | PAL-WH-200-VAL-001 | From BMR document |
| Date | 2026-05-29 | Batch production date |

### 4.3 Label Data File — CSV Template

```
Batch,SampleType,BaseType,MaterialCode,Date
VB-001,R,WH,PAL-WH-200-VAL-001,2026-05-29
VB-001,A,WH,PAL-WH-200-VAL-001,2026-05-29
VB-002,R,WH,PAL-WH-200-VAL-001,2026-05-30
VB-002,A,WH,PAL-WH-200-VAL-001,2026-05-30
...
VB-020,A,CL,PAL-CL-200-VAL-001,2026-06-XX
```

**Total: 40 rows** (20 batches × 2 samples per batch)

---

## 5. Delivery Instructions

| Detail | Instruction |
|--------|-------------|
| Deliver To | PAL Paints — QC Laboratory |
| Bottle Storage | Clean, dry area at ambient temperature |
| Label Application | Apply labels to bottles before sample collection; pre-label all 40 bottles |
| QC Check | Verify label adhesion, print clarity, correct variable data per bottle |
| Disposition | Labelled bottles stored in QC sample rack, organized by batch number |

---

## 6. QC Release Criteria

| Check | Method | Accept |
|-------|--------|--------|
| Bottle integrity | Visual + water leak test (fill, cap, invert 30 s) | No leak |
| Cap seal | Visual — cap seated evenly, no cracks | Pass |
| Label adhesion | Peel test — 90° pull at edge | No edge lift |
| Print legibility | Visual — all fields readable, no smudging | Pass |
| Data accuracy | Match label to CSV — spot-check 10% (4 bottles) | 100% correct |

---

## Revision History

| Rev | Date | Author | Change |
|-----|------|--------|--------|
| 1.0 | 2026-05-29 | CTO | PO issued for retain sample containers and labels |
