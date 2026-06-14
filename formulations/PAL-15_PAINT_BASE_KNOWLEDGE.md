# Paint Base Formulation Knowledge Document

**Document code:** PAL-15-KB-001
**Date:** 2026-05-28
**Author:** Researcher (R&D Chemist)
**Status:** Comprehensive knowledge reference — ready for CTO scale-up

---

## 1. Introduction to Paint Base Systems

Paint bases are the untinted foundation onto which colorants (tinters) are added at the point of sale to produce the final shade. A paint base system typically consists of 3–5 base variants, each with a different level of white pigment (TiO₂), allowing the tinting machine to achieve the full color gamut from pastels to deep hues.

### 1.1 Why Multiple Bases?

The amount of colorant that can be added to a paint can is limited (~120–180 mL per 10 L). If a single "white" base were used for all shades:
- **Pastels** would need only 5–15 mL of colorant — easy.
- **Deep shades** would need far more colorant than the can can hold — and the white TiO₂ already in the base would "pastel" the colour, making true deep shades impossible.

**Solution:** Manufacture bases with decreasing TiO₂ content:

| Base Type | TiO₂ Level | Used For | Colorant Volume |
|---|---|---|---|
| White/Light Base (Base 1) | High (18–22%) | Pastels, off-whites | Low (5–40 mL/L) |
| Medium Base (Base 2) | Medium (10–14%) | Mid-tone colours | Medium (40–80 mL/L) |
| Deep Base (Base 3) | Low (3–6%) | Deep, rich colours | High (80–130 mL/L) |
| Clear/Acrylic Base (Base 4) | Zero | Very deep, saturated colours, glazes | Max (130–180 mL/L) |

### 1.2 Key Physics: PVC and TiO₂ Loading

The **Pigment Volume Concentration (PVC)** is the fundamental formulation parameter:

```
PVC (%) = Volume of Pigment / (Volume of Pigment + Volume of Binder) × 100
```

- **Low PVC (< CPVC):** Binder-rich → glossy, scrub-resistant, high film integrity
- **Critical PVC (CPVC):** ~50–55% for typical acrylic systems — the point where binder just fills all pigment interstices
- **High PVC (> CPVC):** Porous film, dry hide (air voids scatter light), matte finish, lower durability

**TiO₂ is the single most expensive raw material** (₹250–350/kg). Reducing TiO₂ across the base range is the primary cost lever, but it directly affects opacity and coverage.

| Base Type | Target PVC | TiO₂ (% w/w) | Opacity | Coverage (sq.ft/L) |
|---|---|---|---|---|
| White Base | 45–50% | 18–22% | 96–98% | 130–150 |
| Light/Medium Base | 50–55% | 10–14% | 94–96% | 120–140 |
| Deep Base | 55–60% | 3–6% | 90–94% | 100–120 |
| Clear Base | 60–65% | 0% | N/A (tinted opacity) | 80–100 |

---

## 2. Asian Paints Product Range — Competitive Analysis

### 2.1 Royale Series (Premium Interior)

Asian Paints Royale is their flagship premium interior emulsion line, positioned above Apcolite and Tractor lines.

| Product | Base Codes | Key Features | Target Price (per 10L) |
|---|---|---|---|
| Royale Luxury Emulsion | RB1N (White), RB3N (Light), RB21N (Deep) | Teflon surface protector, 10,000+ scrub cycles, low VOC, anti-bacterial, anti-algal, 8-year warranty | ₹5,500–6,500 |
| Royale Matt Luxury Emulsion | RB1N, RB3N, RB21N | Premium matte, Teflon, 5000+ scrub cycles | ₹4,800–5,800 |
| Royale Shyne Luxury Emulsion | RB1N, RB3N, RB21N | High sheen finish, Teflon | ₹5,000–6,000 |
| Royale Glitz Ultra Matt | RB1N, RB3N, RB21N | Ultra matte, 99.9% pure pigments | ₹5,200–6,200 |
| Royale Atmos | RB1N, RB3N, RB21N | Breathable, humidity control, low VOC | ₹5,800–6,800 |

**Base naming convention (Royale):**
- **RB1N (Base 1)** — White base, highest TiO₂, used for pastel/light shades (0Y1–0Y3 in Colour Spectra)
- **RB3N (Base 3)** — Medium/light base, moderate TiO₂, used for mid-tone shades (0Y4–0Y6)
- **RB21N (Base 21)** — Deep base, low TiO₂, used for deep/dark shades (0Y7–0Y9+)

**Inferred RB Code System:**
- RB = Royale Base
- 1 = Light, 3 = Medium, 21 = Deep
- N = New formulation generation

### 2.2 Ultima Series (Premium Exterior)

Asian Paints Apex Ultima is their weather-resistant exterior emulsion line.

| Product | Base Codes | Key Features |
|---|---|---|
| Apex Ultima Protek | UB1N, UB3N, UB21N, UB4 | UV protection, 10-year warranty, weather-resistant |
| Apex Ultima Wall Coat | UB1N, UB3N, UB21N | Textured wall coating, crack-bridging |
| Apex Duralife | DB1N, DB3N, DB21N | Economy exterior emulsion, good durability |

**Ultima base naming:** UB1N (White), UB3N (Light), UB21N (Deep), UB4 (Clear)

### 2.3 Apcolite Series (Mid-Range Interior/Exterior)

| Product | Base Codes | Features |
|---|---|---|
| Apcolite Premium Emulsion | AB1N, AB3N, AB21N | Mid-range interior, matte, 1750+ shades |
| Apcolite Advanced Emulsion | AB1N, AB3N, AB21N | Better washability, anti-fungal |
| Apcolite All Protek Matt | AB1N, AB3N, AB21N | Exterior-grade interior paint |

### 2.4 Tractor Series (Economy)

| Product | Base Codes | Features |
|---|---|---|
| Tractor Acrylic Emulsion | TB1N, TB3N, TB21N | Economy interior, distemper upgrade |
| Tractor Aqualock | TB1N, TB3N | Waterproofing for bathrooms/kitchens |

---

## 3. Standard Formulation Recipes by Base Type

### 3.1 White Base (Base 1, e.g. RB1N)

| # | Raw Material | % w/w | Function | Notes |
|---|---|---|---|---|
| 1 | Water (DM) | 20–22 | Carrier | |
| 2 | Dispersant (Polyacrylate) | 0.4–0.6 | Pigment wetting | BASF Dispex AA 4040 |
| 3 | Wetting Agent (Non-ionic) | 0.1–0.2 | Substrate wetting | Evonik Surfynol 104E |
| 4 | Defoamer (Mineral oil) | 0.2–0.4 | Foam control | BYK-022 |
| 5 | Biocide (BIT/MIT) | 0.15–0.2 | In-can preservation | Dow Dowicil QK-20 |
| 6 | TiO₂ — Rutile | 20–22 | Opacity/whiteness | Kronos 2300 / Tronox CR-828 |
| 7 | CaCO₃ (ground) | 12–15 | Extender/scrub resistance | Omyacarb 2 |
| 8 | Talc (micro-fine) | 4–6 | Extender/smoothness | Mistron Vapor |
| 9 | Kaolin (China Clay) | 3–5 | Film structure/washability | Imerys |
| 10 | Styrene-Acrylic Emulsion (50% solids) | 22–26 | Binder/film former | DIC Dicacryl 4010 |
| 11 | Coalescent (Texanol) | 1.5–2.0 | Film formation aid | Eastman Texanol |
| 12 | Rheology Modifier (HASE/ASE) | 0.3–0.8 | Viscosity control | |
| 13 | pH Adjuster (Ammonia 25%) | 0.2–0.3 | pH 8.5–9.0 | |
| 14 | Water (letdown) | to 100 | Viscosity adjustment | |
| | **Total** | **100.0** | | |

**Target properties:** PVC ~47–50%, Solids ~55–58%, Opacity >96%, Gloss <5 (matte)

### 3.2 Medium/Light Base (Base 3, e.g. RB3N)

| # | Raw Material | % w/w | Difference from White Base |
|---|---|---|---|
| 1 | Water | 25–28 | +5% more water |
| 2 | Dispersant | 0.3–0.5 | Slightly reduced |
| 3 | Defoamer | 0.2–0.3 | Same range |
| 4 | Biocide | 0.15–0.2 | Same |
| 5 | **TiO₂ — Rutile** | **10–14** | **Reduced ~40% from White Base** |
| 6 | CaCO₃ | 18–22 | Increased to compensate volume |
| 7 | Talc | 4–6 | Same |
| 8 | Kaolin | 3–5 | Same |
| 9 | Styrene-Acrylic Emulsion (50%) | 22–26 | Same binder level |
| 10 | Coalescent | 1.5–2.0 | Same |
| 11 | Rheology Modifier | 0.4–0.8 | May need more thickener |
| 12 | Ammonia | 0.2–0.3 | Same |
| 13 | Water (letdown) | to 100 | More letdown water |

**Target properties:** PVC ~50–55%, Solids ~52–55%, Opacity ~94–96%, Gloss <5

**Key insight:** TiO₂ is reduced and replaced largely by CaCO₃ (₹8/kg vs ₹250/kg). This cuts raw material cost by ~₹15–20/kg while maintaining adequate opacity for mid-tone shades that will be tinted.

### 3.3 Deep Base (Base 21, e.g. RB21N)

| # | Raw Material | % w/w | Difference from White Base |
|---|---|---|---|
| 1 | Water | 28–32 | +8–10% more water |
| 2 | Dispersant | 0.2–0.4 | Reduced |
| 3 | Defoamer | 0.2–0.3 | Same |
| 4 | Biocide | 0.15–0.2 | Same |
| 5 | **TiO₂ — Rutile** | **3–6** | **Radically reduced** |
| 6 | CaCO₃ | 20–25 | Increased to fill volume |
| 7 | Talc | 4–6 | Same |
| 8 | Kaolin | 3–5 | Same |
| 9 | Transparent Iron Oxide (optional) | 0–1 | For grey-toned deep base |
| 10 | Styrene-Acrylic Emulsion (50%) | 22–26 | Same binder level (critical for scrub) |
| 11 | Coalescent | 1.5–2.0 | Same |
| 12 | Rheology Modifier | 0.5–1.0 | Higher (more water needs thickening) |
| 13 | Ammonia | 0.2–0.3 | Same |
| 14 | Water (letdown) | to 100 | |

**Target properties:** PVC ~55–60%, Solids ~48–52%, Opacity ~90–94% (tint-dependent), Gloss <5

**Key insight:** At 3–6% TiO₂, the base has very low intrinsic hiding. Opacity comes primarily from the colorants added. This is acceptable because deep shades inherently cover better, and the colorant load (80–130 mL/L) adds significant solids.

### 3.4 Clear Base (Base 4, e.g. UB4)

| # | Raw Material | % w/w |
|---|---|---|
| 1 | Water | 35–40 |
| 2 | Dispersant | 0.1–0.2 |
| 3 | Defoamer | 0.2–0.3 |
| 4 | Biocide | 0.15–0.2 |
| 5 | **TiO₂** | **0** |
| 6 | CaCO₃ (fine grade) | 8–12 |
| 7 | Styrene-Acrylic Emulsion (50%) | 30–35 |
| 8 | Coalescent | 2.0–2.5 |
| 9 | Rheology Modifier | 0.5–1.0 |
| 10 | Ammonia | 0.2–0.3 |
| 11 | Water | to 100 |

**Target:** PVC <40%, High binder content, transparent film. Used for the darkest, most saturated colours and clear glazes.

---

## 4. Manufacturing Process Knowledge

### 4.1 Two-Stage Process

All water-based emulsion paints follow the same two-stage process:

#### Stage 1: Grind (High-Speed Dispersion)
- High-speed disperser at 1500–2500 rpm (tip speed 20–25 m/s)
- Order: Water → Dispersant → Defoamer → Biocide → TiO₂ → Extenders (CaCO₃, Talc, Kaolin)
- Grind to Hegman gauge ≥ 6 (≤ 25 µm agglomerate size)
- Duration: 15–25 min
- Temperature must stay < 50°C to prevent emulsion shock later

#### Stage 2: Letdown (Low-Speed Mixing)
- Reduce speed to 500–800 rpm
- Add emulsion (binder) SLOWLY — fast addition causes foam and poor dispersion
- Pre-blend Texanol coalescent with water, add slowly
- Add rheology modifier (pre-dissolved HEC or HASE)
- Adjust pH to 8.5–9.0 with ammonia
- Final water letdown to target viscosity
- Mix 10 min for homogenization
- **QC hold:** 30 min for de-aeration before testing

### 4.2 Critical Process Parameters

| Parameter | Specification | Impact if Wrong |
|---|---|---|
| Grind tip speed | 20–25 m/s | Inadequate dispersion → poor opacity, settling |
| Grind temperature | <50°C | >50°C can destabilize emulsion during letdown |
| Letdown addition rate | Slow, stream-wise | Fast addition → foam, poor film integrity |
| pH | 8.5–9.0 | <8.0 → poor HEC hydration; >9.5 → ammonia odor |
| Viscosity (KU) | 100–110 KU (roller) | Too low → sagging; too high → brush drag |
| Hegman fineness | ≥ 6 (≤ 25 µm) | Coarse → settling, rough film |

### 4.3 Pigment Volume Concentration (PVC) Calculation

PVC is the single most important formulation parameter. Example for White Base:

**Pigment volume:**
- TiO₂ (22%, density 4.0 g/cm³) → 5.50 cm³
- CaCO₃ (13%, density 2.7) → 4.81 cm³
- Talc (6%, density 2.75) → 2.18 cm³
- **Total pigment volume = 12.49 cm³**

**Binder volume:**
- Styrene-Acrylic emulsion (28% × 50% solids = 14% solid binder, density 1.15) → 12.17 cm³

**PVC = 12.49 / (12.49 + 12.17) × 100 = 50.6%**

For paints below CPVC (~55% for this system), binder encloses each pigment particle → good scrub resistance, film integrity.

---

## 5. Raw Material Specifications

### 5.1 Critical Raw Materials

| Material | Grade | Target Price (INR/kg) | Qualified Suppliers | Function |
|---|---|---|---|---|
| TiO₂ — Rutile | R-996 / CR-828 | ₹230–280 | Kronos, Tronox, Chemours | Opacity, whiteness |
| CaCO₃ (Ground) | 5–15 micron | ₹6–12 | Omya, Gulshan, local | Extender, cost reduction |
| Talc | Micro-fine (10 µm) | ₹10–15 | Mondo Minerals, Golcha | Smoothness, scrub |
| Kaolin (China Clay) | Calcined/hydrous | ₹8–15 | Imerys, Ashapura | Film structure |
| Styrene-Acrylic Emulsion | 50±1% solids, 0.2 µm | ₹160–200 | DIC, BASF, Synthomer | Binder, film former |
| Pure Acrylic Emulsion | 50±1% solids | ₹200–250 | DIC, BASF, Arkema | Premium binder |
| HEC Thickener | 250 HBR grade | ₹300–400 | Ashland (Natrosol), Dow | Rheology |
| HASE Thickener | Alkali-swellable | ₹250–350 | Dow, BASF | Rheology |
| Texanol | Ester alcohol | ₹180–220 | Eastman | Coalescent |
| Dispersant (Polyacrylate) | Sodium salt | ₹100–140 | BASF, BYK | Pigment dispersion |
| Biocide (BIT/MIT) | Blended | ₹350–450 | Dow, Thor | Preservation |

### 5.2 Supplier Qualification Checklist

For any new raw material:
- [ ] MSDS reviewed and available
- [ ] TDS/Batch CoA consistent
- [ ] Batch-to-batch consistency tested (viscosity, pH, solids)
- [ ] Storage stability (6 months at 25°C)
- [ ] Compatibility test with existing formulation
- [ ] Cost quotation with MOQ and lead time
- [ ] Backup supplier identified

---

## 6. Quality Testing Protocols

### 6.1 Incoming Raw Material QC

| Material | Tests | Frequency |
|---|---|---|
| TiO₂ | Whiteness (CIE L*), residue on 45 µm sieve, moisture, oil absorption | Every batch |
| Emulsion | Solids, pH, viscosity, coagulum, particle size | Every batch |
| CaCO₃ | Fineness (sieve residue), brightness, moisture | Every batch |
| Thickeners | Viscosity of standard solution, pH | Every batch |

### 6.2 In-Process and Finished Product QC

| Test | Method | Specification | Frequency |
|---|---|---|---|
| Viscosity (KU) | ASTM D562 (Stormer) | 100–110 KU | Every batch |
| pH | ISO 787-9 | 8.5–9.0 | Every batch |
| Fineness of Grind | Hegman gauge (IS:101) | ≥ 6 | Every batch |
| Opacity (Contrast Ratio) | IS:101 (Part 8/Sec 1) | >95% (white base) | Every batch |
| Drying Time (Touch Dry) | IS 101 | <30 min | Every batch |
| Density | IS 101 | 1.30–1.40 g/mL | Every batch |
| Scrub Resistance | IS 15495 | >500 cycles | Weekly/New formulation |
| Gloss (60°) | ASTM D523 | <5 (matte) | Every batch |
| Heat Stability | 50°C, 4 weeks | No coagulation, viscosity drift <10% | New formulation |

### 6.3 Accelerated Aging Protocol

- **4 weeks at 50°C** → predicts ~24 months at 25°C (Q10 = 2 rule)
- Test at 0, 1, 2, 4 weeks: viscosity, pH, odour, settling, coagulation, opacity
- **Freeze-thaw cycles:** 5 cycles (−5°C to 25°C, 16 hr each) — check for coagulation
- **Settling assessment:** Store 6 months at RT, measure hard-settling volume

---

## 7. Regulatory Compliance Framework

### 7.1 Applicable Indian Standards

| Standard | Scope | Key Requirements |
|---|---|---|
| IS 101 | Methods of sampling and test for paints, varnishes | General test methods |
| IS 15495 | Interior emulsion paints — specification | Scrub resistance, finish uniformity |
| IS 13360 | Plastics — methods of testing | Relevant for packaging |
| CPCB VOC norms | Central Pollution Control Board | <50 g/L for interior emulsion |
| BIS heavy metals | IS 101 | Pb <90 ppm, Cr <60 ppm, Cd <75 ppm, Hg <60 ppm |

### 7.2 VOC Compliance

- Target: <50 g/L (GS-11 standard for flat interior)
- Key VOC contributors: Texanol coalescent, ammonia, residual monomers in emulsion
- Strategy: Use low-VOC coalescent alternatives (e.g., Eastman Optifilm) or reduce coalescent with softer binder resins

### 7.3 Heavy Metal Compliance

All formulations must use raw materials certified heavy-metal-free:
- TiO₂ → check Cr(VI) content (some Chinese grades contain chromium)
- Colored pigments → request CoA for Pb, Cr, Cd, Hg
- Biocides → BIT/MIT blends are heavy-metal-free (avoid organomercury, banned in India)

### 7.4 APEO-Free Compliance

- Many wetting agents and emulsifiers contain APEO (Alkylphenol Ethoxylates)
- Specify APEO-free grades from suppliers
- European Ecolabel and GS-11 both require APEO-free formulations

---

## 8. Cost Structure Analysis

### 8.1 Raw Material Cost per kg (White Base)

| Raw Material | % w/w | Price (INR/kg) | Cost per 100 kg (INR) |
|---|---|---|---|
| Water | 22.0 | 0.1 | 2.20 |
| TiO₂ — Rutile | 22.0 | 250 | 5,500.00 |
| CaCO₃ | 14.0 | 8 | 112.00 |
| Talc | 5.0 | 12 | 60.00 |
| Kaolin | 4.0 | 10 | 40.00 |
| Styrene-Acrylic Emulsion (50%) | 25.0 | 170 | 4,250.00 |
| Dispersant | 0.5 | 120 | 60.00 |
| Wetting Agent | 0.15 | 150 | 22.50 |
| Defoamer | 0.3 | 140 | 42.00 |
| Biocide | 0.2 | 400 | 80.00 |
| HEC Thickener | 0.5 | 350 | 175.00 |
| Texanol | 1.7 | 200 | 340.00 |
| Ammonia | 0.3 | 50 | 15.00 |
| Water (letdown) | 4.35 | 0.1 | 0.44 |
| **Total** | **100.00** | | **₹10,699.14** |

**White Base RM cost: ~₹107/kg | ~₹145/L (SG ~1.35)**

### 8.2 Comparative Cost Across Bases

| Base Type | RM Cost/kg | RM Cost/L | Primary Cost Driver |
|---|---|---|---|
| White (Base 1) | ~₹107/kg | ~₹145/L | TiO₂ (52% of RM cost) |
| Medium (Base 3) | ~₹92/kg | ~₹124/L | TiO₂ cost halved |
| Deep (Base 21) | ~₹85/kg | ~₹115/L | TiO₂ cost minimal |
| Clear (Base 4) | ~₹90/kg | ~₹121/L | Emulsion dominates (70%+) |

### 8.3 Cost Optimization Levers

1. **TiO₂ reduction** — each 1% reduction saves ~₹2.50/kg; trade-off with opacity
2. **Binder substitution** — VA/VeoVa copolymers over pure acrylic save ₹30–50/kg binder
3. **Local extenders** — source CaCO₃ locally vs national brands
4. **Backup suppliers** — negotiate 2–3% discount with dual sourcing
5. **Pack size optimization** — bulk raw material purchases (tanker vs drum) save 5–10%

---

## 9. Base-Specific Tinting Considerations

### 9.1 Colorant Loading Limits

| Base | Max Colorant Volume (per 10L) | Typical Shades |
|---|---|---|
| White | ~40 mL | Pastels, off-whites (e.g. 0Y1–0Y3) |
| Medium | ~80 mL | Mid-tones (e.g. 0Y4–0Y6) |
| Deep | ~130 mL | Deep shades (e.g. 0Y7–0Y8) |
| Clear | ~180 mL | Saturated colours (e.g. 0Y9+) |

### 9.2 Effect on Finished Paint Properties

- **Gloss sheen:** Colorants can increase sheen by 2–5 units at high loading
- **Viscosity:** Colorant vehicles (glycols, water, dispersants) thin the paint — deep base formulas must be pre-thickened to compensate
- **Opacity:** Deep base relies entirely on colorant for hiding — insufficient tint → poor opacity
- **Drying time:** High colorant loads increase drying time (glycol content in colorants)

### 9.3 Formulation Adjustments for High-Load Tinting

- Start deep base at 105–110 KU (vs 100 KU for white base)
- Add 0.1–0.3% additional HASE thickener
- Reduce letdown water proportionally
- Consider pH shift from colorants — buffer with ammonia

---

## 10. Base System Design Strategy for New Manufacturing

### 10.1 Recommended Minimum Base Range

For a new paint manufacturing operation targeting the Indian market, the recommended base architecture is:

1. **White Base (Premium)** — 22% TiO₂, pure acrylic binder, for Royale-equivalent
2. **White Base (Economy)** — 18% TiO₂, styrene-acrylic binder, for Apcolite-equivalent
3. **Medium Base** — 12% TiO₂, styrene-acrylic, mid-tone shades
4. **Deep Base** — 5% TiO₂, styrene-acrylic, deep shades
5. **Clear Base** — 0% TiO₂, for deepest colours and tinting base

**Phase 1 (Initial launch):** 3 bases (White, Medium, Deep) — sufficient for 80%+ of market shades
**Phase 2 (Full range):** Add Clear Base + Economy White Base

### 10.2 Shade Card Coverage

| # of Bases | Shades Possible | Market Coverage |
|---|---|---|
| 1 (White) | ~200 pastels | ~30% |
| 2 (White + Medium) | ~600 shades | ~55% |
| 3 (White + Medium + Deep) | ~1200 shades | ~85% |
| 4 (+ Clear) | ~1750+ shades | ~95%+ |

### 10.3 Equipment Requirements

| Equipment | Specification | Estimated Cost (INR) | Purpose |
|---|---|---|---|
| High-speed Disperser | 30–50 HP, variable speed | ₹5–10 L | Grind stage |
| Letdown Mixer | 10–20 HP, low speed | ₹2–5 L | Letdown stage |
| Ball Mill / Bead Mill | 100–500 L capacity | ₹3–8 L | Alternative grind (finer dispersion) |
| Viscosity Measurement | Stormer viscometer (KU) | ₹50,000 | QC |
| Hegman Gauge | 0–100 µm | ₹5,000 | Grind fineness |
| pH Meter | Digital | ₹15,000 | QC |
| Balance (lab) | 0.01 g precision | ₹20,000 | Formulation |
| Accelerated Oven | 50°C ± 2°C | ₹1–2 L | Stability testing |
| Scrub Tester | Automated | ₹80,000 | Durability testing |

---

## 11. Recommended Development Roadmap

Based on this knowledge, I recommend the following workstreams:

1. **Formulation PAL-16:** Develop a White Base (Base 1) — premium interior emulsion at ~₹107/kg RM cost
2. **Formulation PAL-17:** Develop a Medium Base (Base 3) — ~₹92/kg RM cost
3. **Formulation PAL-18:** Develop a Deep Base (Base 21) — ~₹85/kg RM cost
4. **Raw Material Qualification:** Source and qualify all raw materials from 2+ suppliers each
5. **Tinting System:** Define colorant palette (8–16 colorants) compatible with the base system
6. **Scale-Up:** Transfer lab formulations to pilot plant (CTO lead)

---

## 12. References

- IS 101: Methods of sampling and test for paints, varnishes and related products
- IS 15495: Interior emulsion paints — specification
- CPCB VOC norms for architectural paints (2023)
- Green Seal GS-11 Standard for paints and coatings
- Asian Paints product technical datasheets (Royale, Ultima, Apcolite)
- Raykem Water-Based Emulsion Paint Formulation Guide
- PCC Group Formulation Guide for Paints and Coatings
- Paint Formulation Science — Peter Collins (RSC Coatings Group)

---

## Revision History

| Revision | Date | Author | Changes |
|---|---|---|---|
| 1.0 | 2026-05-28 | Researcher | Initial comprehensive knowledge document |


---

## Addendum A — CTO Manufacturing Scale-Up Analysis (2026-05-28)

### A.1 Scale-Up Physics: 1L Lab → 1000L Production

The lab formulation must be validated at three intermediate scales before commercial production:

| Scale | Batch Size | Equipment | Purpose | Risk Factor |
|---|---|---|---|---|
| Lab | 1–5 L | High-shear lab disperser | Proof of concept, base formulation | Low |
| Pilot | 20–50 L | 5 HP pilot disperser + letdown | Process parameter validation, QC method development | Medium |
| Trial | 200–500 L | 20 HP production disperser | Scale-up validation, yield optimization | High |
| Commercial | 1000–5000 L | 30–50 HP disperser | Full production | Critical |

**Known scale-up failure modes for paint manufacturing:**

| Lab OK → Production Failure | Root Cause | Mitigation |
|---|---|---|
| Poor TiO₂ dispersion (haze/low opacity) | Lower shear per unit volume at scale | Increase disperser RPM proportional to impeller diameter change; maintain tip speed 20–25 m/s |
| Foaming in letdown | Deeper vortex in larger tank entrains more air | Use variable-speed letdown; add anti-vortex baffles; increase defoamer by 0.1% at scale |
| Viscosity drop vs lab | Higher shear history thins rheology modifier | Adjust HASE/HEC level by +10–15% for first production trials |
| Settling in storage | Larger tank hydrostatic pressure compresses sediment | Optimize CaCO₃ particle size distribution; add anti-settling agent (0.1% bentonite clay) |
| Batch-to-batch colour variation | Weighing errors amplified at scale | Install load cells on all vessels; automate weigh-feed |

### A.2 Recommended Plant Layout (Modular, 3-Zone)

**Zone 1: Raw Material Storage (200 sq.ft)**
- TiO₂ silo (5-tonne capacity) or bulk bag unloading station
- Emulsion tanks (2 × 5000 L SS304, temperature-controlled, <35°C)
- Extender bags (CaCO₃, Talc, Kaolin) on pallet racks
- Liquid additive drums (Texanol, dispersant, defoamer) in bundled containment area
- DM water tank (5000 L, SS304) with conductivity monitor

**Zone 2: Manufacturing Floor (500 sq.ft)**
- High-speed disperser (30 HP, variable frequency drive, 500–3000 RPM)
  - Recommended vendor: **Ross / MixMor / S.F. Engineering** — ₹6–8 L
- Letdown mixer (15 HP, slow-speed anchor agitator)
  - Same vendor — ₹2.5–4 L
- Transfer pump (diaphragm or progressive cavity, 50 LPM) — ₹80K–1.2 L
- 2 × 1000 L SS mixing vessels (interchangeable: one grinding, one letting down)
- In-line filter (100 µm bag filter) on fill line

**Zone 3: Fill & Pack + QC (300 sq.ft)**
- Semi-automatic filling machine (4–20 L pails, 10–15 pails/min) — ₹3–5 L
- Manual labeling station
- QC lab bench (20 sq.ft): Stormer viscometer, Hegman gauge, pH meter, opacity drawdown table
- Accelerated aging oven (50°C ± 2°C)

**Total equipment investment estimate: ₹15–22 L (excluding building/civil)**

### A.3 Production Capacity Modelling

Assumptions: 1 disperser, 1 letdown vessel, 8-hr shift, 300 working days/year.

| Base Type | Batch Size | Cycle Time (grind + letdown + QC) | Batches/Day | Annual Output (L) |
|---|---|---|---|---|
| White | 500 L | 3.5 hr | 2 | 300,000 |
| Medium | 500 L | 3.0 hr | 2.5 | 375,000 |
| Deep | 500 L | 3.0 hr | 2.5 | 375,000 |
| Clear | 500 L | 2.5 hr | 3 | 450,000 |
| **Mix (3 bases)** | 500 L avg | 3.2 hr avg | 2.3 avg | **~350,000 L/year** |

**Scale lever:** Adding a second disperser doubles capacity to ~700,000 L/year at ~₹5 L additional investment.

### A.4 Supply Chain Risk Assessment

| Raw Material | Single-Source Risk | Lead Time | Buffer Stock (days) | Backup Supplier |
|---|---|---|---|---|
| TiO₂ — Rutile (Kronos/Tronox) | Medium (only 3 global producers) | 30–45 days | 45 | Chemours Ti-Pure R-706 |
| Styrene-Acrylic Emulsion | Medium | 7–14 days | 30 | BASF Acronal / DIC Dicacryl swap-tested |
| CaCO₃ (Ground) | Low (many Indian sources) | 3–7 days | 14 | Any local grinding mill |
| Texanol | Medium (Eastman sole source) | 30–45 days | 60 | Low-VOC alternative: Optifilm |
| HEC Thickener | Medium | 14–21 days | 30 | Dow Cellosize / Ashland swap-tested |

**Critical recommendation:** Pre-qualify 2 suppliers for every material before first commercial batch. Run a 200 L trial batch with each supplier's material to validate compatibility.

### A.5 Quality System Implementation Plan (Phase 1)

| Month | Milestone |
|---|---|
| M1 | Define incoming QC specs for all 12 raw materials; procure QC instruments |
| M2 | Write Batch Manufacturing Record (BMR) templates; train operators |
| M3 | Validate all test methods (precision, accuracy, repeatability); set pass/fail limits |
| M4 | Run 20 consecutive validation batches; calculate process capability (Cpk) |
| M5 | Freeze all QC specs and BMRs; release for commercial production |

### A.6 Safety & Environmental Compliance

| Area | Requirement | Action | Estimated Cost |
|---|---|---|---|
| Ventilation | Explosion-proof exhaust in mixing area | Install 2 × 2000 CFM spark-proof fans | ₹1.5 L |
| PPE | Safety glasses, gloves, respirators for all operators | Procure kit × 5 operators + spares | ₹30K |
| Spill containment | Bunded storage for all liquid drums | Build concrete bund wall (100% containment) | ₹50K |
| Waste disposal | Wash water + paint sludge treatment | Settling tank + pH neutralization system | ₹2 L |
| Fire safety | Fire extinguisher (CO₂ + foam) in each zone | 6 × extinguishers + inspection | ₹40K |
| MSDS | All raw materials must have MSDS on file | Collect from suppliers before first receipt | Labor |

**Ongoing compliance:** Register with State Pollution Control Board for consent-to-operate. Maintain VOC records (expected <50 g/L).

### A.7 Maintenance Cadence (Preventive)

| Equipment | Daily | Weekly | Monthly | Quarterly |
|---|---|---|---|---|
| High-speed disperser | Check shaft seal temp | Grease bearings | Inspect impeller wear | Change gearbox oil |
| Letdown mixer | Listen for unusual noise | Check anchor clearance | Inspect shaft alignment | Change oil |
| Transfer pump | Check mechanical seal | Check pressure relief valve | Replace diaphragm if worn | Full overhaul |
| Filling machine | Clean nozzles | Check weighing accuracy | Calibrate load cells | Replace fill hoses |

### A.8 Cost-per-Litre Build-Up (White Base Example)

| Component | INR/L | % of Total |
|---|---|---|
| Raw materials | 145.00 | 72.5% |
| Labor (5 operators × ₹20K/mo, 10KL/mo output) | 10.00 | 5.0% |
| Packaging (4L pail + lid + label) | 18.00 | 9.0% |
| Utilities (power + water) | 3.00 | 1.5% |
| QC testing (₹2K/batch, 500L batch) | 4.00 | 2.0% |
| Maintenance (1.5% of equipment value/year) | 2.50 | 1.3% |
| Depreciation (10-year straight line) | 4.50 | 2.3% |
| Overhead (rent, admin, compliance) | 12.00 | 6.0% |
| **Total manufacturing cost** | **₹199.00/L** | **99.6%** |
| Margin (target 25%) | 49.75 | — |
| **Target wholesale price** | **~₹249/L** | — |

**Price positioning vs Asian Paints:** Royale 10L retails at ~₹550–650/L. Our cost structure allows a wholesale price of ~₹249/L (55–60% below retail equivalent) — viable for a B2B bulk-supply model targeting painters, contractors, and regional dealers.

---

## Revision History

| Revision | Date | Author | Changes |
|---|---|---|---|
| 1.0 | 2026-05-28 | Researcher | Initial comprehensive knowledge document |
| 1.1 | 2026-05-28 | CTO | Added Addendum A: manufacturing scale-up, plant layout, production capacity, supply chain risk, quality system plan, safety compliance, maintenance cadence, cost-per-litre build-up |

## Related Issues

| Issue | Title | Status |
|---|---|---|
| [PAL-16](/PAL/issues/PAL-16) | Develop White Base (Base 1) | In review |
| [PAL-17](/PAL/issues/PAL-17) | Develop Medium Base (Base 3) | Done |
| [PAL-18](/PAL/issues/PAL-18) | Develop Deep Base (Base 21) | Done |
| [PAL-22](/PAL/issues/PAL-22) | Scale-up validation: Lab to pilot to commercial | In progress |
| [PAL-32](/PAL/issues/PAL-32) | Pilot batch validation (20-50 L) | Todo |
| [PAL-33](/PAL/issues/PAL-33) | Trial batch validation (200 L) | Blocked by PAL-32 |
| [PAL-34](/PAL/issues/PAL-34) | Commercial batch validation (500 L) | Blocked by PAL-33 |
