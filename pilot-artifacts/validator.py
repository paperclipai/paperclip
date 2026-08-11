"""
SSI-HP Enrichment Row Validator
Deterministic validation: schema, enums, regex, cross-field consistency.
No model calls. Importable as a library or run as a CLI.

Returns: {"valid": bool, "errors": [...], "confidence_flags": [...]}
"""

import json
import re
from pathlib import Path
from typing import Any


SCHEMA = json.loads((Path(__file__).with_name("schema.json")).read_text())
SCHEMA_PROPERTIES: dict[str, dict[str, Any]] = SCHEMA["properties"]
REQUIRED_FIELDS: tuple[str, ...] = tuple(SCHEMA["required"])

# ---------------------------------------------------------------------------
# Enum constants (mirrors schema.json exactly — kept inline for zero-deps)
# ---------------------------------------------------------------------------

MATERIAL_TYPES = {
    "quartz", "granite", "marble", "quartzite", "porcelain",
    "sintered_stone", "laminate", "solid_surface", "recycled_glass",
    "terrazzo", "soapstone", "slate", "travertine", "limestone",
    "onyx", "other",
}

COLOR_FAMILIES = {
    "white", "off_white", "gray", "black", "beige", "cream",
    "brown", "taupe", "blue", "green", "red", "pink", "gold", "multicolor",
}

FINISHES = {
    "polished", "honed", "matte", "leathered", "brushed",
    "sandblasted", "flamed", "bush_hammered", "satin",
}

PATTERN_TYPES = {
    "solid", "veined", "flecked", "marbled", "speckled",
    "linear", "geometric", "organic",
}

APPLICATIONS = {
    "countertop", "kitchen_island", "bathroom_vanity", "flooring",
    "wall_cladding", "shower_surround", "backsplash", "fireplace_surround",
    "outdoor_kitchen", "table_top", "commercial",
}

WEATHER_RATINGS = {"excellent", "good", "fair", "not_rated"}

RESISTANCE_LEVELS = {"excellent", "good", "moderate", "low"}

CARE_LEVELS = {"low", "moderate", "high"}

PRICE_TIERS = {"budget", "mid", "premium", "luxury"}

AVAILABILITY_VALUES = {
    "in_stock", "made_to_order", "limited_stock", "discontinued", "coming_soon",
}

EDGE_PROFILES = {
    "eased", "beveled", "bullnose", "ogee", "waterfall",
    "mitered", "dupont", "chiseled",
}

CERTIFICATIONS = {
    "NSF_51", "GREENGUARD_Gold", "LEED_eligible",
    "ISO_14001", "recycled_content_certified",
}

SKU_PATTERN = re.compile(r"^[A-Z0-9\-]{3,30}$")
COUNTRY_CODE_PATTERN = re.compile(r"^[A-Z]{2}$")


# ---------------------------------------------------------------------------
# Validator
# ---------------------------------------------------------------------------

def validate(row: dict[str, Any]) -> dict[str, Any]:
    """
    Validate a single enriched catalog row.

    Returns:
        {
            "valid": bool,
            "errors": list[str],          # hard failures — row rejected
            "confidence_flags": list[str] # soft warnings — route to review
        }
    """
    errors: list[str] = []
    flags: list[str] = []

    # schema.json is the contract for public keys, required fields, and value
    # types. Validate untrusted input before any regex, len(), or collection
    # operation so callers always receive a result rather than a Python error.
    if not isinstance(row, dict):
        return _result(["type:row must be object"], flags)

    unknown_keys = sorted(set(row) - set(SCHEMA_PROPERTIES))
    errors.extend(f"unknown_property:{key}" for key in unknown_keys)

    for field, value in row.items():
        definition = SCHEMA_PROPERTIES.get(field)
        if definition is None:
            continue
        # Preserve the stable required-field diagnostic below for null required
        # values instead of replacing it with a generic JSON-schema type error.
        if value is None and field in REQUIRED_FIELDS:
            continue
        schema_types = definition["type"]
        allowed_types = schema_types if isinstance(schema_types, list) else [schema_types]
        if not any(_matches_json_type(value, schema_type) for schema_type in allowed_types):
            errors.append(f"type:{field} must be {' or '.join(allowed_types)}")

    if errors:
        return _result(errors, flags)

    # -- 1. Required fields present -----------------------------------------
    for field in REQUIRED_FIELDS:
        if field not in row:
            errors.append(f"missing_required_field:{field}")
        elif row[field] is None and field != "enrichment_confidence":
            errors.append(f"null_required_field:{field}")

    if errors:
        # No point running further checks on a structurally broken row
        return _result(errors, flags)

    # -- 2. Type checks -------------------------------------------------------
    if not isinstance(row["sku"], str):
        errors.append("type:sku must be string")
    if not isinstance(row["product_name"], str):
        errors.append("type:product_name must be string")
    if not isinstance(row["is_outdoor"], bool):
        errors.append("type:is_outdoor must be boolean")
    if not isinstance(row["enrichment_confidence"], (int, float)):
        errors.append("type:enrichment_confidence must be number")
    if not isinstance(row["applications"], list):
        errors.append("type:applications must be array")

    if errors:
        return _result(errors, flags)

    # -- 3. Regex constraints -------------------------------------------------
    if not SKU_PATTERN.match(row["sku"]):
        errors.append(
            f"pattern:sku '{row['sku']}' does not match ^[A-Z0-9\\-]{{3,30}}$"
        )

    coo = row.get("country_of_origin")
    if coo is not None and not COUNTRY_CODE_PATTERN.match(coo):
        errors.append(
            f"pattern:country_of_origin '{coo}' must be ISO 3166-1 alpha-2 (e.g. US, IT)"
        )

    # -- 4. String length checks ----------------------------------------------
    if len(row["product_name"]) < 2 or len(row["product_name"]) > 120:
        errors.append("length:product_name must be 2–120 characters")

    mfr = row.get("manufacturer")
    if mfr is not None and (len(mfr) < 2 or len(mfr) > 80):
        errors.append("length:manufacturer must be 2–80 characters if set")

    series = row.get("series_name")
    if series is not None and len(series) > 80:
        errors.append("length:series_name max 80 characters")

    notes = row.get("enrichment_notes")
    if notes is not None and len(notes) > 500:
        errors.append("length:enrichment_notes max 500 characters")

    # -- 5. Enum membership ---------------------------------------------------
    _check_enum(row, "material_type", MATERIAL_TYPES, errors)
    _check_enum(row, "primary_color_family", COLOR_FAMILIES, errors)
    _check_enum(row, "finish", FINISHES, errors)

    if row.get("secondary_color_family") is not None:
        _check_enum(row, "secondary_color_family", COLOR_FAMILIES, errors)

    if row.get("pattern_type") is not None:
        _check_enum(row, "pattern_type", PATTERN_TYPES, errors)

    _check_enum(row, "price_tier", PRICE_TIERS, errors)
    _check_enum(row, "availability", AVAILABILITY_VALUES, errors)

    if row.get("weather_rating") is not None:
        _check_enum(row, "weather_rating", WEATHER_RATINGS, errors)

    if row.get("heat_resistance") is not None:
        _check_enum(row, "heat_resistance", RESISTANCE_LEVELS, errors)

    if row.get("scratch_resistance") is not None:
        _check_enum(row, "scratch_resistance", RESISTANCE_LEVELS, errors)

    if row.get("care_level") is not None:
        _check_enum(row, "care_level", CARE_LEVELS, errors)

    # applications — array of enums
    if isinstance(row.get("applications"), list):
        if len(row["applications"]) < 1:
            errors.append("min_items:applications must have at least 1 item")
        seen = set()
        for index, app in enumerate(row["applications"]):
            if not isinstance(app, str):
                errors.append(f"type:applications item {index} must be string")
                continue
            if app not in APPLICATIONS:
                errors.append(f"enum:applications contains invalid value '{app}'")
            if app in seen:
                errors.append(f"unique:applications value '{app}' is duplicated")
            seen.add(app)

    # edge_profiles_available
    eps = row.get("edge_profiles_available")
    if eps is not None:
        if not isinstance(eps, list):
            errors.append("type:edge_profiles_available must be array or null")
        else:
            seen_ep = set()
            for index, ep in enumerate(eps):
                if not isinstance(ep, str):
                    errors.append(f"type:edge_profiles_available item {index} must be string")
                    continue
                if ep not in EDGE_PROFILES:
                    errors.append(f"enum:edge_profiles_available invalid value '{ep}'")
                if ep in seen_ep:
                    errors.append(f"unique:edge_profiles_available '{ep}' duplicated")
                seen_ep.add(ep)

    # certifications
    certs = row.get("certifications")
    if certs is not None:
        if not isinstance(certs, list):
            errors.append("type:certifications must be array or null")
        else:
            seen_cert = set()
            for index, cert in enumerate(certs):
                if not isinstance(cert, str):
                    errors.append(f"type:certifications item {index} must be string")
                    continue
                if cert not in CERTIFICATIONS:
                    errors.append(f"enum:certifications invalid value '{cert}'")
                if cert in seen_cert:
                    errors.append(f"unique:certifications '{cert}' duplicated")
                seen_cert.add(cert)

    # -- 6. Numeric range checks ----------------------------------------------
    conf = row["enrichment_confidence"]
    if isinstance(conf, (int, float)) and not (0.0 <= conf <= 1.0):
        errors.append(
            f"range:enrichment_confidence {conf} must be 0.0–1.0"
        )

    rcp = row.get("recycled_content_pct")
    if rcp is not None:
        if not isinstance(rcp, (int, float)):
            errors.append("type:recycled_content_pct must be number or null")
        elif not (0 <= rcp <= 100):
            errors.append(f"range:recycled_content_pct {rcp} must be 0–100")

    wy = row.get("warranty_years")
    if wy is not None:
        if not isinstance(wy, (int, float)):
            errors.append("type:warranty_years must be number or null")
        elif not (0 <= wy <= 25):
            errors.append(f"range:warranty_years {wy} must be 0–25")

    thicknesses = row.get("thickness_options_mm")
    if thicknesses is not None:
        if not isinstance(thicknesses, list):
            errors.append("type:thickness_options_mm must be array or null")
        else:
            if len(thicknesses) < 1:
                errors.append("min_items:thickness_options_mm must have at least 1 item")
            seen_thick = set()
            for index, t in enumerate(thicknesses):
                if not isinstance(t, (int, float)) or isinstance(t, bool):
                    errors.append(f"type:thickness_options_mm item {index} must be number")
                    continue
                elif not (6 <= t <= 60):
                    errors.append(f"range:thickness_options_mm {t}mm must be 6–60")
                if t in seen_thick:
                    errors.append(f"unique:thickness_options_mm {t} duplicated")
                seen_thick.add(t)

    # -- 7. Boolean type checks (nullable booleans) ---------------------------
    for bool_field in ("uv_resistant", "stain_resistant", "sealing_required"):
        val = row.get(bool_field)
        if val is not None and not isinstance(val, bool):
            errors.append(f"type:{bool_field} must be boolean or null")

    # -- 8. Cross-field consistency (HARD) ------------------------------------

    # is_outdoor=true requires weather_rating to be non-null
    if row["is_outdoor"] is True:
        wr = row.get("weather_rating")
        if wr is None:
            errors.append(
                "cross_field:is_outdoor=true but weather_rating is null — required"
            )

    # is_outdoor=false and outdoor_kitchen in applications => suspicious
    if row["is_outdoor"] is False and isinstance(row.get("applications"), list):
        if "outdoor_kitchen" in row["applications"]:
            errors.append(
                "cross_field:is_outdoor=false but 'outdoor_kitchen' is in applications — inconsistent"
            )

    # sealing_required=false AND material is natural stone => flag (not hard error)
    natural_stones = {"granite", "marble", "quartzite", "travertine", "limestone",
                      "onyx", "soapstone", "slate", "terrazzo"}
    if (
        row.get("sealing_required") is False
        and row.get("material_type") in natural_stones
    ):
        flags.append(
            "confidence:natural_stone with sealing_required=false is unusual — verify"
        )

    # discontinued product with stain_resistant=true and certifications populated => flag
    if row.get("availability") == "discontinued":
        if row.get("certifications"):
            flags.append(
                "confidence:discontinued product with active certifications listed — verify if certs are still valid"
            )

    # -- 9. Confidence flags (SOFT) ------------------------------------------

    conf_val = row.get("enrichment_confidence")
    if isinstance(conf_val, (int, float)):
        if conf_val < 0.6:
            flags.append(
                f"low_confidence:enrichment_confidence={conf_val:.2f} (<0.60) — route to review"
            )
        elif conf_val < 0.75:
            flags.append(
                f"moderate_confidence:enrichment_confidence={conf_val:.2f} (<0.75)"
            )

    lcf = row.get("low_confidence_fields")
    if lcf and isinstance(lcf, list) and len(lcf) > 0:
        flags.append(
            f"model_flagged_fields:{','.join(lcf)}"
        )

    # Many null optional fields on a non-coming_soon product => flag
    optional_fields = [
        "manufacturer", "series_name", "secondary_color_family", "pattern_type",
        "thickness_options_mm", "weather_rating", "uv_resistant", "heat_resistance",
        "scratch_resistance", "stain_resistant", "sealing_required", "care_level",
        "edge_profiles_available", "certifications", "recycled_content_pct",
        "warranty_years", "country_of_origin",
    ]
    null_count = sum(
        1 for f in optional_fields if row.get(f) is None
    )
    if null_count > 12 and row.get("availability") != "coming_soon":
        flags.append(
            f"sparse_row:{null_count}/17 optional fields are null — may need manual enrichment"
        )

    return _result(errors, flags)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _check_enum(
    row: dict, field: str, valid_values: set, errors: list
) -> None:
    val = row.get(field)
    if val is not None and val not in valid_values:
        errors.append(
            f"enum:{field} value '{val}' not in allowed set {sorted(valid_values)}"
        )


def _matches_json_type(value: Any, schema_type: str) -> bool:
    """Return whether value matches the JSON Schema primitive type exactly."""
    if schema_type == "null":
        return value is None
    if schema_type == "string":
        return isinstance(value, str)
    if schema_type == "boolean":
        return isinstance(value, bool)
    if schema_type == "array":
        return isinstance(value, list)
    if schema_type == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if schema_type == "object":
        return isinstance(value, dict)
    return False


def _result(errors: list, flags: list) -> dict:
    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "confidence_flags": flags,
    }


# ---------------------------------------------------------------------------
# Batch helper
# ---------------------------------------------------------------------------

def validate_batch(rows: list[dict]) -> list[dict]:
    """Validate a list of rows; each result includes the source row index."""
    results = []
    for idx, row in enumerate(rows):
        result = validate(row)
        result["row_index"] = idx
        result["sku"] = row.get("sku", "<missing>")
        results.append(result)
    return results


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main() -> None:
    import sys
    import argparse

    parser = argparse.ArgumentParser(
        description="Validate SSI-HP enrichment rows against schema.json"
    )
    parser.add_argument(
        "input",
        nargs="?",
        default="-",
        help="JSON file path or '-' for stdin. Single row or array of rows.",
    )
    parser.add_argument(
        "--summary", action="store_true",
        help="Print a one-line summary per row instead of full JSON"
    )
    args = parser.parse_args()

    if args.input == "-":
        raw = sys.stdin.read()
    else:
        raw = Path(args.input).read_text()

    data = json.loads(raw)
    rows = data if isinstance(data, list) else [data]

    results = validate_batch(rows)

    if args.summary:
        for r in results:
            status = "PASS" if r["valid"] else "FAIL"
            flag_count = len(r["confidence_flags"])
            err_count = len(r["errors"])
            print(
                f"[{status}] row={r['row_index']} sku={r['sku']} "
                f"errors={err_count} flags={flag_count}"
            )
    else:
        print(json.dumps(results, indent=2))

    failed = sum(1 for r in results if not r["valid"])
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
