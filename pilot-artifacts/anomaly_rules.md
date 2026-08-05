# Anomaly Rules — Local Reviewer (`llama3.1:8b-instruct`)

**Reviewer model:** `llama3.1:8b-instruct` (q4_K_M)
**Threshold:** `anomaly_score ≥ 0.5` → flagged for human review
**Reviewer reads:** input product data + enrichment output side-by-side
**Reviewer does NOT:** call external tools, access databases, or produce structured fields beyond `anomaly_score` and `anomaly_reason`

---

## Purpose

The local reviewer is a cheap pre-filter before the human review queue. Its job is narrow:
> Given the original product description and the enriched JSON row, does the enrichment look coherent and trustworthy?

It is NOT a schema validator (that's `validator.py`). It checks *semantic* plausibility: are the enriched attributes consistent with what the description actually says?

---

## Scoring model

The reviewer emits a single `anomaly_score` from 0.0 to 1.0:

| Range | Meaning | Action |
|---|---|---|
| 0.0 – 0.29 | Clean — enrichment looks coherent | Auto-approve eligible |
| 0.30 – 0.49 | Minor concerns — possible but not definitive | Auto-approve eligible; logged |
| 0.50 – 0.69 | Suspicious — one or more notable inconsistencies | Flag → SSI Dir queue |
| 0.70 – 0.89 | Likely error — clear mismatch or hallucination evidence | Flag → SSI Dir + note |
| 0.90 – 1.00 | Certain error — obvious fabrication or contradiction | Flag → reject, re-run |

Rows with `validator.py` errors are NOT sent to the reviewer (they're already rejected).

---

## Rule catalog

Rules are grouped by type. Each rule has a **weight** (how much it contributes to `anomaly_score`) and a **trigger condition**.

### Group A — Material / description mismatch (weight 0.20–0.35 each)

| Rule ID | Trigger | Weight | Example |
|---|---|---|---|
| A1 | `material_type` does not match description keywords | 0.30 | SKU says "quartz" in name, output says `granite` |
| A2 | `finish` contradicts description (e.g., description says "matte" but output has `polished`) | 0.25 | "rough brushed surface" → `polished` |
| A3 | `primary_color_family` is clearly wrong for the description (e.g., description says "jet black" but output is `beige`) | 0.35 | Strong contradiction only |
| A4 | `pattern_type` is `solid` when description mentions "veining", "veins", "movement" | 0.20 | |
| A5 | `manufacturer` does not match brand name clearly stated in description | 0.25 | Description says "Silestone" but manufacturer = null or different brand |

### Group B — Outdoor / weather consistency (weight 0.25–0.40 each)

| Rule ID | Trigger | Weight | Example |
|---|---|---|---|
| B1 | `is_outdoor=true` but no outdoor application in `applications` array | 0.30 | `applications` only has `countertop`, `bathroom_vanity` |
| B2 | `is_outdoor=false` but description explicitly mentions outdoor, patio, pool, frost-proof | 0.40 | Clear contradiction |
| B3 | `weather_rating=excellent` for materials known to be freeze-thaw sensitive (travertine, limestone, marble, onyx) | 0.25 | Natural porous stone shouldn't be "excellent" unless treated |
| B4 | `uv_resistant=false` for an outdoor-rated product | 0.20 | Soft flag only |

### Group C — Price / tier plausibility (weight 0.15–0.25 each)

| Rule ID | Trigger | Weight | Example |
|---|---|---|---|
| C1 | `price_tier=budget` for materials that are inherently expensive (onyx, quartzite, sintered_stone, exotic marbles) | 0.20 | |
| C2 | `price_tier=luxury` for materials that are inherently cheap (laminate, basic solid_surface) | 0.25 | |
| C3 | `price_tier` is inconsistent with `warranty_years` (e.g., budget tier with 25-year warranty) | 0.15 | Soft flag |

### Group D — Sealing / care logic (weight 0.20–0.30 each)

| Rule ID | Trigger | Weight | Example |
|---|---|---|---|
| D1 | Natural porous stone (`marble`, `travertine`, `limestone`, `onyx`, `soapstone`) with `sealing_required=false` AND `care_level=low` simultaneously | 0.30 | Both wrong together is worse than one |
| D2 | `quartz` or `sintered_stone` or `solid_surface` with `sealing_required=true` | 0.25 | These materials don't need sealing by design |
| D3 | `care_level=low` for materials with `scratch_resistance=low` and `stain_resistant=false` | 0.20 | Inconsistent care assessment |

### Group E — Application / material fit (weight 0.15–0.25 each)

| Rule ID | Trigger | Weight | Example |
|---|---|---|---|
| E1 | `flooring` in applications for `onyx` or thin slab material (thickness < 10mm) without explicit note | 0.20 | Fragile materials rarely used as flooring |
| E2 | `shower_surround` in applications for `laminate` without sealing note | 0.25 | Laminate and direct water exposure is problematic |
| E3 | Only one application listed for a material that is commonly used in many contexts | 0.15 | Very narrow application scope for a general material |

### Group F — Confidence / completeness (weight 0.10–0.20 each)

| Rule ID | Trigger | Weight | Example |
|---|---|---|---|
| F1 | `enrichment_confidence` > 0.90 but `low_confidence_fields` has ≥ 3 items | 0.20 | Model claims high confidence but flags many fields |
| F2 | `enrichment_confidence` > 0.85 on a `coming_soon` product with very sparse description | 0.15 | Overconfident on sparse data |
| F3 | `enrichment_notes` describes a correction (e.g., "corrected material_type") but `low_confidence_fields` doesn't include that field | 0.15 | Inconsistent self-reporting |
| F4 | `low_confidence_fields` is empty but description is sparse (< 20 words) | 0.10 | Soft flag: model may be overconfident |

---

## Score computation

The reviewer checks all applicable rules. For each group (A–F), only the highest-weight triggered rule contributes — this avoids double-counting correlated signals. The final score is:

```
anomaly_score = min(1.0, sum-over-groups(max-weight-per-group))
```

Groups A, B, C, D, E, F each contribute at most their single highest triggered rule weight to the sum.

---

## Output format

The reviewer returns a single JSON object on each row:

```json
{
  "anomaly_score": 0.55,
  "anomaly_reason": "B2: description mentions patio/frost-proof but is_outdoor=false. A1: description says 'quartz' but material_type=granite.",
  "triggered_rules": ["B2", "A1"]
}
```

- `anomaly_score`: float 0.0–1.0
- `anomaly_reason`: one or two sentences naming the triggered rules. Max 300 characters.
- `triggered_rules`: list of rule IDs (e.g. `["B2", "A1"]`)

---

## What the reviewer does NOT do

- Does not re-validate schema (validator.py handles that)
- Does not rewrite or correct the enrichment
- Does not look up external databases
- Does not fabricate product facts not present in the input or enrichment
- Does not pass judgment on business decisions (pricing, distribution channels)
- Does not flag for subjective aesthetic reasons

---

## Calibration notes

- The weight table is an initial estimate calibrated against the 12 few-shot examples in `prompt.md`. Recalibrate after Phase A dry-run by checking the human-approved subset against reviewer scores.
- Target: flagged rate ≤25% on a well-curated catalog. If flagged rate > 35% in Phase A, recalibrate Group C and F weights downward.
- Preferred calibration data: 50+ rows with human-verified labels (correct / incorrect / uncertain).
