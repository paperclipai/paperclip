# Operator Training Guide — Quality Control

**Document code:** PAL-21-QC-005
**Date:** 2026-05-28
**Author:** CTO
**Status:** Final — ready for training rollout

---

## 1. Purpose

This guide provides all production operators with the knowledge required to execute in-process QC checks, fill BMRs correctly, and follow quality procedures. Every operator must read this guide and pass a practical assessment before working independently.

---

## 2. Training Modules

| Module | Topic | Duration | Format |
|---|---|---|---|
| M1 | Quality principles & why QC matters | 30 min | Classroom |
| M2 | BMR — how to fill it correctly | 45 min | Hands-on |
| M3 | Hegman gauge — how to measure fineness | 30 min | Practical demo |
| M4 | pH measurement | 20 min | Practical demo |
| M5 | Stormer viscometer — how to measure KU | 30 min | Practical demo |
| M6 | Density measurement | 20 min | Practical demo |
| M7 | QC hold points — what to do at each | 20 min | Classroom |
| M8 | Handling OOS & deviations | 30 min | Classroom |
| M9 | Safety in QC testing | 20 min | Classroom |
| **Total** | | **4 hr 45 min** | |

---

## 3. Module Content Summaries

### M1 — Quality Principles
- **Why QC matters:** One bad batch = wasted raw materials (₹10K+), lost production time (3+ hr), unhappy customers
- **The QC golden rule:** If you didn't measure it, you didn't make it
- **The four QC eyes principle:** Every check is done, witnessed, and signed
- **Right first time:** It's cheaper to do it right in grind than to fix it in letdown

**Key message for operators:** *You are the first line of quality defence. The instruments tell you what's happening. If something looks wrong, stop and ask.*

### M2 — BMR Completion
- **BMR Location:** On clipboard at each work station
- **Fill in real time** — not from memory at end of shift
- **Every field:** If a field is not applicable, write "N/A" — never leave blank
- **Corrections:** Single line through error → initial → date → correct value
- **Signatures:** Print name + sign + date on every section you perform
- **Common mistakes to avoid:**
  - ❌ Filling BMR from memory at shift end
  - ❌ Using pencil instead of pen
  - ❌ Erasing or using white-out
  - ❌ Leaving blank fields

### M3 — Hegman Gauge (Fineness of Grind)
**Why it matters:** Large pigment particles (agglomerates) make paint feel gritty, reduce opacity, and cause settling.

**Steps:**
1. Place gauge on a flat, level surface
2. Put a small amount of grind paste at the deep end (100 µm side)
3. Hold scraper at 90° to gauge, draw down smoothly in 1 second
4. Look at the drawn-down film immediately
5. Read the Hegman number where the first continuous scratch line appears
6. Record in BMR

**Common errors:**
- Drawing too fast or slow — aim for consistent 1-second draw
- Not cleaning the gauge between tests — paint residue alters reading
- Reading after paste dries — read within 5 seconds

**Target:** ≥ 6 Hegman (≤ 25 µm)

### M4 — pH Measurement
**Why it matters:** pH affects thickener performance, shelf stability, and odour.

**Steps:**
1. Turn on pH meter, ensure calibrated (check calibration log)
2. Rinse probe with DM water, blot dry with Kimwipe
3. Immerse probe in paint sample (about 2 cm depth)
4. Wait for reading to stabilise (30–60 sec)
5. Record value in BMR
6. Rinse probe with DM water, return to storage solution

**Target:** 8.5–9.0

**Troubleshooting:**
- Reading drifts → probe may need cleaning (soak in 0.1M HCl, 10 min)
- Calibration failed → check buffer solutions expiry date

### M5 — Stormer Viscometer (KU)
**Why it matters:** Viscosity determines application properties. Too thick = brush drag. Too thin = sagging/dripping.

**Steps:**
1. Condition sample to 25°C (water bath if needed)
2. Fill Stormer cup to brim — no air bubbles
3. Attach paddle spindle, raise cup to immerse
4. Release brake, let paddle spin
5. Read KU after 30 seconds
6. Record in BMR
7. Clean paddle and cup thoroughly with water

**Target:** 100–110 KU

**Note:** Temperature changes viscosity. Cold sample → higher KU. Hot sample → lower KU. Always test at 25°C.

### M6 — Density Measurement
**Why it matters:** Density confirms correct solids loading. Deviation indicates weighing error or formula mistake.

**Steps:**
1. Weigh clean dry density cup on balance → record empty weight
2. Fill cup completely with paint, avoiding air bubbles
3. Level off with spatula — flat, no meniscus
4. Weigh filled cup → record filled weight
5. Density = (filled weight − empty weight) / cup volume (usually 100 mL)
6. Record in BMR

**Target:** Per base type (White: 1.30–1.40, Medium: 1.25–1.35, Deep: 1.20–1.30, Clear: 1.15–1.25 g/mL)

### M7 — QC Hold Points
**Three hold points you must know:**

| Hold Point | When | What You Check | Who Signs |
|---|---|---|---|
| HP-1 | After grind, before letdown | Hegman, temperature | QC operator |
| HP-2 | After letdown, before final water | pH, viscosity (preliminary), foam | QC operator |
| HP-3 | Final batch, before filling | Full QC panel | QC supervisor |

**Critical rule: NEVER proceed past a hold point without a PASS from QC.**

If you are waiting for QC and they are busy — wait. Do not proceed. Write the delay on the BMR.

### M8 — Handling OOS & Deviations
**If a test fails:**
1. **STOP** — do not proceed to the next stage
2. **FLAG** — call the shift supervisor immediately
3. **RECORD** — note the failure on the BMR
4. **LABEL** — affix RED "QC HOLD" tag on the batch
5. **ADJUST** — if the spec allows adjustment (pH, viscosity), follow adjustment guidelines
6. **RE-TEST** — if adjusted, re-test and record both results
7. **IF STILL OOS** — QC supervisor / manager makes the call: rework, recycle, or reject

**Examples of acceptable adjustments:**
- Viscosity too high → add water, re-test
- pH too low → add ammonia, re-test

**Examples requiring supervisor decision:**
- Hegman <6 after re-grind
- Opacity below spec
- Any critical failure (coagulation, phase separation)

### M9 — Safety in QC Testing
- **Always wear:** safety glasses, nitrile gloves, lab coat
- **Chemicals handled in QC:** ammonia (irritant), Texanol (mild irritant), biocide (skin sensitiser)
- **Never pipette by mouth** — use bulb pipette or syringe
- **Wash hands** after handling any paint sample
- **Report spills** immediately — paint is slippery and hard to clean when dry
- **Broken glass** — use dustpan and brush, never bare hands
- **Stormer viscometer:** keep fingers clear of rotating paddle

---

## 4. Operator Qualification — Practical Assessment

Each operator must demonstrate:

| Skill | Assessed By | Pass Criteria |
|---|---|---|
| Hegman gauge measurement | QC Supervisor | 3 consecutive readings within 0.5 units of QC check |
| pH measurement | QC Supervisor | 3 within 0.1 pH of QC standard |
| Stormer KU measurement | QC Supervisor | 3 within 2 KU of QC standard |
| Density measurement | QC Supervisor | 3 within 0.01 g/mL of QC standard |
| BMR completion | QC Supervisor | Fill a mock BMR with zero errors |
| OOS procedure | QC Supervisor | Verbal quiz — state correct action for 3 failure scenarios |

**Training Record:** Operator name, date, module completion, and assessor signature recorded in PAL-21-QC-005R Operator Training Log.

**Re-qualification:** Annually, or after any 6+ month gap.

---

## 5. Quick Reference Card (for lamination)

```
┌──────────────────────────────────────────────────────┐
│              QC QUICK REFERENCE CARD                  │
├──────────────────────────────────────────────────────┤
│ HP-1: Hegman ≥ 6 | Temp <50°C | Smooth paste        │
│ HP-2: pH 8.5–9.0 | KU 95–110 | Foam <5mm            │
│ HP-3: KU 100–110 | pH 8.5–9.0 | Density per spec    │
│       Opacity per spec | Gloss <5 | Touch dry <30min │
│                                                      │
│ STOP → FLAG → RECORD → HOLD → ADJUST → RE-TEST      │
│                                                      │
│ "If you didn't measure it, you didn't make it."      │
└──────────────────────────────────────────────────────┘
```

---

## Revision History

| Rev | Date | Author | Change |
|---|---|---|---|
| 1.0 | 2026-05-28 | CTO | Initial release |
