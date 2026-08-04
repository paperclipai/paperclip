# Enrichment Prompt Template — qwen2.5:14b-instruct

**Model:** `qwen2.5:14b-instruct` (q4_K_M)
**Task:** Enrich a Sage Surfaces SSI-HP catalog row with structured product attributes.
**Output:** Strict JSON matching `schema.json`. No prose. No markdown fences.

---

## System Prompt

```
You are a product data enrichment specialist for Sage Surfaces, a countertop and surface materials distributor. Your job is to analyze product information and produce a structured JSON object describing a surface material's attributes.

Rules:
1. Output ONLY a valid JSON object. No explanation, no markdown, no prose.
2. Every required field must be present. Optional fields may be null if genuinely unknown.
3. Use only the exact enum values listed in the schema. Do not invent new values.
4. If is_outdoor is true, weather_rating must NOT be null.
5. Set enrichment_confidence to a float 0.0–1.0 reflecting your overall certainty.
6. List any fields you are uncertain about in low_confidence_fields.
7. Keep enrichment_notes under 200 characters if used.

Schema reference (required fields: sku, product_name, material_type, primary_color_family, finish, applications, price_tier, availability, is_outdoor, enrichment_confidence):
- material_type: quartz | granite | marble | quartzite | porcelain | sintered_stone | laminate | solid_surface | recycled_glass | terrazzo | soapstone | slate | travertine | limestone | onyx | other
- primary_color_family: white | off_white | gray | black | beige | cream | brown | taupe | blue | green | red | pink | gold | multicolor
- finish: polished | honed | matte | leathered | brushed | sandblasted | flamed | bush_hammered | satin
- pattern_type: solid | veined | flecked | marbled | speckled | linear | geometric | organic | null
- applications (array): countertop | kitchen_island | bathroom_vanity | flooring | wall_cladding | shower_surround | backsplash | fireplace_surround | outdoor_kitchen | table_top | commercial
- weather_rating: excellent | good | fair | not_rated | null
- heat_resistance / scratch_resistance: excellent | good | moderate | low | null
- care_level: low | moderate | high | null
- price_tier: budget | mid | premium | luxury
- availability: in_stock | made_to_order | limited_stock | discontinued | coming_soon
- edge_profiles_available: eased | beveled | bullnose | ogee | waterfall | mitered | dupont | chiseled
- certifications: NSF_51 | GREENGUARD_Gold | LEED_eligible | ISO_14001 | recycled_content_certified
- country_of_origin: ISO 3166-1 alpha-2 code (e.g. US, IT, IN, BR) or null
```

---

## User Prompt Template

```
Enrich the following surface product. Return only the JSON object.

Product input:
---
SKU: {{sku}}
Name: {{product_name}}
Raw description: {{raw_description}}
Manufacturer: {{manufacturer_raw}}
Category tag: {{category_tag}}
Price point (USD/sqft): {{price_per_sqft}}
---

Output the enriched JSON now:
```

---

## Few-Shot Examples

The examples below are included in the user turn, before the live product input, separated by `---`.

---

### Example 1 — Standard quartz, polished, indoor only

**Input:**
```
SKU: CS-WHT-3200
Name: Calacatta Snow
Raw description: White quartz with soft grey veining. High gloss. 3cm kitchen countertop.
Manufacturer: CaesarStone
Category tag: kitchen
Price point (USD/sqft): 85
```

**Output:**
```json
{
  "sku": "CS-WHT-3200",
  "product_name": "Calacatta Snow",
  "manufacturer": "CaesarStone",
  "series_name": null,
  "material_type": "quartz",
  "primary_color_family": "white",
  "secondary_color_family": "gray",
  "finish": "polished",
  "pattern_type": "veined",
  "thickness_options_mm": [30],
  "applications": ["countertop", "kitchen_island"],
  "is_outdoor": false,
  "weather_rating": null,
  "uv_resistant": false,
  "heat_resistance": "moderate",
  "scratch_resistance": "excellent",
  "stain_resistant": true,
  "sealing_required": false,
  "care_level": "low",
  "price_tier": "premium",
  "availability": "in_stock",
  "edge_profiles_available": ["eased", "beveled", "bullnose", "mitered"],
  "certifications": ["NSF_51", "GREENGUARD_Gold"],
  "recycled_content_pct": null,
  "warranty_years": 10,
  "country_of_origin": "IL",
  "enrichment_confidence": 0.92,
  "enrichment_notes": null,
  "low_confidence_fields": null
}
```

---

### Example 2 — Outdoor porcelain, excellent weather rating

**Input:**
```
SKU: POL-GRY-OUT-22
Name: Alpine Concrete Outdoor
Raw description: Large-format porcelain tile. Frost-proof, slip-resistant, UV stable. For outdoor patios, pool surrounds. 20mm thick.
Manufacturer: Florim
Category tag: outdoor_patio
Price point (USD/sqft): 42
```

**Output:**
```json
{
  "sku": "POL-GRY-OUT-22",
  "product_name": "Alpine Concrete Outdoor",
  "manufacturer": "Florim",
  "series_name": null,
  "material_type": "porcelain",
  "primary_color_family": "gray",
  "secondary_color_family": null,
  "finish": "matte",
  "pattern_type": "solid",
  "thickness_options_mm": [20],
  "applications": ["flooring", "outdoor_kitchen", "wall_cladding"],
  "is_outdoor": true,
  "weather_rating": "excellent",
  "uv_resistant": true,
  "heat_resistance": "good",
  "scratch_resistance": "good",
  "stain_resistant": true,
  "sealing_required": false,
  "care_level": "low",
  "price_tier": "mid",
  "availability": "in_stock",
  "edge_profiles_available": ["eased"],
  "certifications": null,
  "recycled_content_pct": null,
  "warranty_years": 5,
  "country_of_origin": "IT",
  "enrichment_confidence": 0.89,
  "enrichment_notes": null,
  "low_confidence_fields": null
}
```

---

### Example 3 — Natural granite, high-maintenance, sealing required

**Input:**
```
SKU: GR-BLK-ABSLT
Name: Absolute Black Granite
Raw description: Premium absolute black granite slab from India. Mirror polish. 2cm and 3cm available. Kitchen and bathroom.
Manufacturer: null
Category tag: stone
Price point (USD/sqft): 55
```

**Output:**
```json
{
  "sku": "GR-BLK-ABSLT",
  "product_name": "Absolute Black Granite",
  "manufacturer": null,
  "series_name": null,
  "material_type": "granite",
  "primary_color_family": "black",
  "secondary_color_family": null,
  "finish": "polished",
  "pattern_type": "solid",
  "thickness_options_mm": [20, 30],
  "applications": ["countertop", "bathroom_vanity", "kitchen_island"],
  "is_outdoor": false,
  "weather_rating": null,
  "uv_resistant": null,
  "heat_resistance": "excellent",
  "scratch_resistance": "excellent",
  "stain_resistant": false,
  "sealing_required": true,
  "care_level": "moderate",
  "price_tier": "mid",
  "availability": "in_stock",
  "edge_profiles_available": ["eased", "beveled", "bullnose", "ogee"],
  "certifications": null,
  "recycled_content_pct": null,
  "warranty_years": null,
  "country_of_origin": "IN",
  "enrichment_confidence": 0.88,
  "enrichment_notes": "Manufacturer not specified; common generic import. Warranty not listed.",
  "low_confidence_fields": ["warranty_years"]
}
```

---

### Example 4 — Recycled glass composite, sustainability certifications

**Input:**
```
SKU: RG-TEAL-COAST
Name: Coastal Tide
Raw description: 85% post-consumer recycled glass in resin binder. Aqua/teal colorway. Kitchen counter, bar top. GREENGUARD certified.
Manufacturer: IceStone
Category tag: eco_premium
Price point (USD/sqft): 110
```

**Output:**
```json
{
  "sku": "RG-TEAL-COAST",
  "product_name": "Coastal Tide",
  "manufacturer": "IceStone",
  "series_name": null,
  "material_type": "recycled_glass",
  "primary_color_family": "blue",
  "secondary_color_family": "green",
  "finish": "polished",
  "pattern_type": "speckled",
  "thickness_options_mm": [30],
  "applications": ["countertop", "kitchen_island", "backsplash", "table_top"],
  "is_outdoor": false,
  "weather_rating": null,
  "uv_resistant": null,
  "heat_resistance": "moderate",
  "scratch_resistance": "moderate",
  "stain_resistant": true,
  "sealing_required": false,
  "care_level": "moderate",
  "price_tier": "premium",
  "availability": "made_to_order",
  "edge_profiles_available": ["eased", "bullnose"],
  "certifications": ["GREENGUARD_Gold", "recycled_content_certified"],
  "recycled_content_pct": 85,
  "warranty_years": 5,
  "country_of_origin": "US",
  "enrichment_confidence": 0.91,
  "enrichment_notes": null,
  "low_confidence_fields": null
}
```

---

### Example 5 — Discontinued luxury marble, multiple low-confidence fields

**Input:**
```
SKU: MRB-GLD-CLEO
Name: Cleopatra Gold
Raw description: Italian Giallo Siena marble. Gold and cream tones with brown veining. Limited stock — final slabs. High-end residential.
Manufacturer: null
Category tag: luxury_natural_stone
Price point (USD/sqft): 220
```

**Output:**
```json
{
  "sku": "MRB-GLD-CLEO",
  "product_name": "Cleopatra Gold",
  "manufacturer": null,
  "series_name": null,
  "material_type": "marble",
  "primary_color_family": "gold",
  "secondary_color_family": "cream",
  "finish": "polished",
  "pattern_type": "veined",
  "thickness_options_mm": [20, 30],
  "applications": ["countertop", "bathroom_vanity", "wall_cladding", "fireplace_surround"],
  "is_outdoor": false,
  "weather_rating": null,
  "uv_resistant": false,
  "heat_resistance": "good",
  "scratch_resistance": "low",
  "stain_resistant": false,
  "sealing_required": true,
  "care_level": "high",
  "price_tier": "luxury",
  "availability": "limited_stock",
  "edge_profiles_available": ["eased", "ogee", "dupont"],
  "certifications": null,
  "recycled_content_pct": null,
  "warranty_years": null,
  "country_of_origin": "IT",
  "enrichment_confidence": 0.76,
  "enrichment_notes": "Manufacturer not listed. Warranty absent for natural stone — common. Marble scratch resistance inferred from material class.",
  "low_confidence_fields": ["manufacturer", "warranty_years", "scratch_resistance"]
}
```

---

### Example 6 — Sintered stone, leathered finish, outdoor capable

**Input:**
```
SKU: DKTN-DGST-VL
Name: Domoos Dekton Vintage Lava
Raw description: Ultra-compact sintered surface. Leathered finish. Black/charcoal. Fire, frost, UV, stain proof. Thickness 8mm and 12mm. Outdoor rated.
Manufacturer: Cosentino
Category tag: ultra-compact
Price point (USD/sqft): 95
```

**Output:**
```json
{
  "sku": "DKTN-DGST-VL",
  "product_name": "Domoos Dekton Vintage Lava",
  "manufacturer": "Cosentino",
  "series_name": "Dekton",
  "material_type": "sintered_stone",
  "primary_color_family": "black",
  "secondary_color_family": "gray",
  "finish": "leathered",
  "pattern_type": "solid",
  "thickness_options_mm": [8, 12],
  "applications": ["countertop", "outdoor_kitchen", "flooring", "wall_cladding", "backsplash"],
  "is_outdoor": true,
  "weather_rating": "excellent",
  "uv_resistant": true,
  "heat_resistance": "excellent",
  "scratch_resistance": "excellent",
  "stain_resistant": true,
  "sealing_required": false,
  "care_level": "low",
  "price_tier": "premium",
  "availability": "in_stock",
  "edge_profiles_available": ["eased", "beveled", "mitered"],
  "certifications": ["GREENGUARD_Gold"],
  "recycled_content_pct": null,
  "warranty_years": 25,
  "country_of_origin": "ES",
  "enrichment_confidence": 0.95,
  "enrichment_notes": null,
  "low_confidence_fields": null
}
```

---

### Example 7 — Laminate, budget tier, minimal attributes

**Input:**
```
SKU: LM-WLNT-245
Name: Walnut Butcher Block Look
Raw description: High-pressure laminate with wood grain texture. 0.5 inch thick. Kitchen counter only. Budget line.
Manufacturer: Wilsonart
Category tag: laminate_budget
Price point (USD/sqft): 12
```

**Output:**
```json
{
  "sku": "LM-WLNT-245",
  "product_name": "Walnut Butcher Block Look",
  "manufacturer": "Wilsonart",
  "series_name": null,
  "material_type": "laminate",
  "primary_color_family": "brown",
  "secondary_color_family": null,
  "finish": "matte",
  "pattern_type": "linear",
  "thickness_options_mm": [13],
  "applications": ["countertop"],
  "is_outdoor": false,
  "weather_rating": null,
  "uv_resistant": false,
  "heat_resistance": "low",
  "scratch_resistance": "moderate",
  "stain_resistant": true,
  "sealing_required": false,
  "care_level": "low",
  "price_tier": "budget",
  "availability": "in_stock",
  "edge_profiles_available": ["eased", "beveled"],
  "certifications": null,
  "recycled_content_pct": null,
  "warranty_years": 1,
  "country_of_origin": "US",
  "enrichment_confidence": 0.93,
  "enrichment_notes": null,
  "low_confidence_fields": null
}
```

---

### Example 8 — Travertine, outdoor capable, fair weather rating

**Input:**
```
SKU: TRV-IVRY-FILL
Name: Ivory Travertine Filled & Honed
Raw description: Natural travertine, filled and honed. Ivory/cream. Can be used outdoors but susceptible to freeze-thaw. Sealing essential.
Manufacturer: MSI Stone
Category tag: natural_stone_outdoor
Price point (USD/sqft): 38
```

**Output:**
```json
{
  "sku": "TRV-IVRY-FILL",
  "product_name": "Ivory Travertine Filled & Honed",
  "manufacturer": "MSI Stone",
  "series_name": null,
  "material_type": "travertine",
  "primary_color_family": "cream",
  "secondary_color_family": "beige",
  "finish": "honed",
  "pattern_type": "organic",
  "thickness_options_mm": [13, 20],
  "applications": ["flooring", "wall_cladding", "bathroom_vanity", "outdoor_kitchen"],
  "is_outdoor": true,
  "weather_rating": "fair",
  "uv_resistant": true,
  "heat_resistance": "good",
  "scratch_resistance": "moderate",
  "stain_resistant": false,
  "sealing_required": true,
  "care_level": "high",
  "price_tier": "mid",
  "availability": "in_stock",
  "edge_profiles_available": ["eased", "bullnose", "chiseled"],
  "certifications": null,
  "recycled_content_pct": null,
  "warranty_years": null,
  "country_of_origin": "TR",
  "enrichment_confidence": 0.82,
  "enrichment_notes": "Outdoor rating is fair due to freeze-thaw sensitivity; requires annual sealing.",
  "low_confidence_fields": ["warranty_years"]
}
```

---

### Example 9 — Solid surface, commercial, made to order

**Input:**
```
SKU: COR-PLNWHT-SS
Name: Arctic White Corian
Raw description: DuPont Corian solid surface. Seamless joins. Non-porous. For healthcare, hospitality, commercial counters. Custom fabrication only. NSF food-safe certified. Repairable.
Manufacturer: DuPont
Category tag: commercial_healthcare
Price point (USD/sqft): 65
```

**Output:**
```json
{
  "sku": "COR-PLNWHT-SS",
  "product_name": "Arctic White Corian",
  "manufacturer": "DuPont",
  "series_name": "Corian",
  "material_type": "solid_surface",
  "primary_color_family": "white",
  "secondary_color_family": null,
  "finish": "matte",
  "pattern_type": "solid",
  "thickness_options_mm": [13],
  "applications": ["countertop", "commercial", "bathroom_vanity"],
  "is_outdoor": false,
  "weather_rating": null,
  "uv_resistant": null,
  "heat_resistance": "moderate",
  "scratch_resistance": "good",
  "stain_resistant": true,
  "sealing_required": false,
  "care_level": "low",
  "price_tier": "mid",
  "availability": "made_to_order",
  "edge_profiles_available": ["eased", "bullnose", "waterfall"],
  "certifications": ["NSF_51"],
  "recycled_content_pct": null,
  "warranty_years": 10,
  "country_of_origin": "US",
  "enrichment_confidence": 0.94,
  "enrichment_notes": null,
  "low_confidence_fields": null
}
```

---

### Example 10 — Coming-soon quartzite, genuinely sparse data

**Input:**
```
SKU: QZ-SURF-2026
Name: Mont Blanc Quartzite
Raw description: New 2026 arrival. Quartzite from Brazil. White with pale blue undertones. Details TBA.
Manufacturer: null
Category tag: natural_stone_preview
Price point (USD/sqft): null
```

**Output:**
```json
{
  "sku": "QZ-SURF-2026",
  "product_name": "Mont Blanc Quartzite",
  "manufacturer": null,
  "series_name": null,
  "material_type": "quartzite",
  "primary_color_family": "white",
  "secondary_color_family": "blue",
  "finish": "polished",
  "pattern_type": "veined",
  "thickness_options_mm": null,
  "applications": ["countertop", "bathroom_vanity"],
  "is_outdoor": false,
  "weather_rating": null,
  "uv_resistant": null,
  "heat_resistance": "excellent",
  "scratch_resistance": "good",
  "stain_resistant": null,
  "sealing_required": true,
  "care_level": "moderate",
  "price_tier": "premium",
  "availability": "coming_soon",
  "edge_profiles_available": null,
  "certifications": null,
  "recycled_content_pct": null,
  "warranty_years": null,
  "country_of_origin": "BR",
  "enrichment_confidence": 0.55,
  "enrichment_notes": "Very sparse listing. Attributes inferred from material class and country. Price absent — tier is provisional.",
  "low_confidence_fields": ["finish", "pattern_type", "stain_resistant", "price_tier", "applications"]
}
```

---

### Example 11 — Onyx with multicolor, unusual display application

**Input:**
```
SKU: ONX-GRN-LIT
Name: Verde Onyx Backlit Panel
Raw description: Translucent green onyx slab for backlit wall panels and bar tops. Feature installation only. High-end hospitality. 2cm polished.
Manufacturer: Stone Italiana
Category tag: luxury_feature
Price point (USD/sqft): 280
```

**Output:**
```json
{
  "sku": "ONX-GRN-LIT",
  "product_name": "Verde Onyx Backlit Panel",
  "manufacturer": "Stone Italiana",
  "series_name": null,
  "material_type": "onyx",
  "primary_color_family": "green",
  "secondary_color_family": "multicolor",
  "finish": "polished",
  "pattern_type": "organic",
  "thickness_options_mm": [20],
  "applications": ["wall_cladding", "table_top", "commercial"],
  "is_outdoor": false,
  "weather_rating": null,
  "uv_resistant": false,
  "heat_resistance": "low",
  "scratch_resistance": "low",
  "stain_resistant": false,
  "sealing_required": true,
  "care_level": "high",
  "price_tier": "luxury",
  "availability": "made_to_order",
  "edge_profiles_available": ["eased", "mitered"],
  "certifications": null,
  "recycled_content_pct": null,
  "warranty_years": null,
  "country_of_origin": "IT",
  "enrichment_confidence": 0.71,
  "enrichment_notes": "bar_top not in schema enum; mapped to table_top + commercial. Onyx durability inferred from material class.",
  "low_confidence_fields": ["applications", "heat_resistance", "scratch_resistance"]
}
```

---

### Example 12 — Quartzite misidentified as quartz in source, confidence flag

**Input:**
```
SKU: QZ-STAT-BLU
Name: Fantasy Brown Quartzite (listed as quartz in ERP)
Raw description: Natural stone slab. Fantasy Brown coloring. Used in kitchens, bathrooms, fireplaces. Marketed as quartz but is natural stone. Sealing recommended.
Manufacturer: Levantina
Category tag: natural_stone
Price point (USD/sqft): 72
```

**Output:**
```json
{
  "sku": "QZ-STAT-BLU",
  "product_name": "Fantasy Brown Quartzite",
  "manufacturer": "Levantina",
  "series_name": null,
  "material_type": "quartzite",
  "primary_color_family": "brown",
  "secondary_color_family": "beige",
  "finish": "polished",
  "pattern_type": "veined",
  "thickness_options_mm": [20, 30],
  "applications": ["countertop", "bathroom_vanity", "fireplace_surround"],
  "is_outdoor": false,
  "weather_rating": null,
  "uv_resistant": null,
  "heat_resistance": "excellent",
  "scratch_resistance": "good",
  "stain_resistant": false,
  "sealing_required": true,
  "care_level": "moderate",
  "price_tier": "premium",
  "availability": "in_stock",
  "edge_profiles_available": ["eased", "beveled", "bullnose", "ogee"],
  "certifications": null,
  "recycled_content_pct": null,
  "warranty_years": null,
  "country_of_origin": "ES",
  "enrichment_confidence": 0.78,
  "enrichment_notes": "Source ERP listed as quartz but description and name confirm quartzite. Corrected material_type.",
  "low_confidence_fields": ["material_type", "warranty_years"]
}
```
