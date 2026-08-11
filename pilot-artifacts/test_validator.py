"""
Unit tests for validator.py — SSI-HP catalog enrichment validator.
Run with: python -m pytest test_validator.py -v
Or:        python test_validator.py
"""

import sys
import os
import unittest
sys.path.insert(0, os.path.dirname(__file__))

from validator import validate, validate_batch

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _base_row(**overrides):
    """Minimal valid row for test construction."""
    row = {
        "sku": "TEST-001",
        "product_name": "Test Surface",
        "manufacturer": None,
        "series_name": None,
        "material_type": "quartz",
        "primary_color_family": "white",
        "secondary_color_family": None,
        "finish": "polished",
        "pattern_type": "veined",
        "thickness_options_mm": [20, 30],
        "applications": ["countertop"],
        "is_outdoor": False,
        "weather_rating": None,
        "uv_resistant": None,
        "heat_resistance": "moderate",
        "scratch_resistance": "excellent",
        "stain_resistant": True,
        "sealing_required": False,
        "care_level": "low",
        "price_tier": "mid",
        "availability": "in_stock",
        "edge_profiles_available": ["eased", "beveled"],
        "certifications": None,
        "recycled_content_pct": None,
        "warranty_years": None,
        "country_of_origin": "US",
        "enrichment_confidence": 0.88,
        "enrichment_notes": None,
        "low_confidence_fields": None,
    }
    row.update(overrides)
    return row


def _has_error(result, fragment):
    return any(fragment in e for e in result["errors"])


def _has_flag(result, fragment):
    return any(fragment in f for f in result["confidence_flags"])


# ---------------------------------------------------------------------------
# Schema-pass tests
# ---------------------------------------------------------------------------

class TestSchemaPass(unittest.TestCase):

    def test_minimal_valid_row(self):
        row = _base_row()
        r = validate(row)
        self.assertTrue(r["valid"], f"Expected valid; errors: {r['errors']}")
        self.assertEqual(r["errors"], [])

    def test_valid_outdoor_row_with_weather_rating(self):
        row = _base_row(
            sku="DKTN-001",
            material_type="sintered_stone",
            is_outdoor=True,
            weather_rating="excellent",
            uv_resistant=True,
            applications=["outdoor_kitchen", "countertop"],
        )
        r = validate(row)
        self.assertTrue(r["valid"], f"Errors: {r['errors']}")

    def test_valid_natural_stone_sealing_required(self):
        row = _base_row(
            sku="GR-BLK-001",
            material_type="granite",
            sealing_required=True,
            care_level="moderate",
        )
        r = validate(row)
        self.assertTrue(r["valid"], f"Errors: {r['errors']}")

    def test_valid_nullable_fields_all_null(self):
        row = _base_row(
            manufacturer=None,
            series_name=None,
            secondary_color_family=None,
            pattern_type=None,
            thickness_options_mm=None,
            weather_rating=None,
            uv_resistant=None,
            heat_resistance=None,
            scratch_resistance=None,
            stain_resistant=None,
            sealing_required=None,
            care_level=None,
            edge_profiles_available=None,
            certifications=None,
            recycled_content_pct=None,
            warranty_years=None,
            country_of_origin=None,
            enrichment_notes=None,
            low_confidence_fields=None,
        )
        r = validate(row)
        self.assertTrue(r["valid"], f"Errors: {r['errors']}")

    def test_valid_recycled_glass_with_certifications(self):
        row = _base_row(
            sku="RG-TEAL-001",
            material_type="recycled_glass",
            certifications=["GREENGUARD_Gold", "recycled_content_certified"],
            recycled_content_pct=85,
            enrichment_confidence=0.91,
        )
        r = validate(row)
        self.assertTrue(r["valid"], f"Errors: {r['errors']}")

    def test_valid_confidence_boundary_values(self):
        for conf in (0.0, 0.5, 1.0):
            row = _base_row(enrichment_confidence=conf)
            r = validate(row)
            self.assertTrue(r["valid"], f"conf={conf} should be valid; errors: {r['errors']}")

    def test_valid_multiple_applications(self):
        row = _base_row(
            applications=["countertop", "bathroom_vanity", "kitchen_island", "backsplash"]
        )
        r = validate(row)
        self.assertTrue(r["valid"], f"Errors: {r['errors']}")


# ---------------------------------------------------------------------------
# Schema-fail tests
# ---------------------------------------------------------------------------

class TestSchemaFail(unittest.TestCase):

    def test_unknown_property_is_rejected_deterministically(self):
        result = validate(_base_row(unexpected_source_field="value"))

        self.assertFalse(result["valid"])
        self.assertEqual(result["errors"], ["unknown_property:unexpected_source_field"])

    def test_malformed_optional_scalars_return_type_errors_not_exceptions(self):
        cases = {
            "manufacturer": 42,
            "country_of_origin": ["US"],
            "enrichment_notes": {"note": "bad"},
        }
        for field, value in cases.items():
            with self.subTest(field=field):
                result = validate(_base_row(**{field: value}))
                self.assertFalse(result["valid"])
                self.assertEqual(result["errors"], [f"type:{field} must be string or null"])

    def test_missing_required_sku(self):
        row = _base_row()
        del row["sku"]
        r = validate(row)
        self.assertFalse(r["valid"])
        self.assertTrue(_has_error(r, "missing_required_field:sku"))

    def test_missing_required_material_type(self):
        row = _base_row()
        del row["material_type"]
        r = validate(row)
        self.assertFalse(r["valid"])
        self.assertTrue(_has_error(r, "missing_required_field:material_type"))

    def test_null_required_field_product_name(self):
        row = _base_row(product_name=None)
        r = validate(row)
        self.assertFalse(r["valid"])
        self.assertTrue(_has_error(r, "null_required_field:product_name"))

    def test_invalid_sku_pattern_lowercase(self):
        row = _base_row(sku="abc-001")
        r = validate(row)
        self.assertFalse(r["valid"])
        self.assertTrue(_has_error(r, "pattern:sku"))

    def test_invalid_sku_pattern_too_short(self):
        row = _base_row(sku="AB")
        r = validate(row)
        self.assertFalse(r["valid"])
        self.assertTrue(_has_error(r, "pattern:sku"))

    def test_invalid_material_type_enum(self):
        row = _base_row(material_type="concrete")
        r = validate(row)
        self.assertFalse(r["valid"])
        self.assertTrue(_has_error(r, "enum:material_type"))

    def test_invalid_finish_enum(self):
        row = _base_row(finish="glossy")
        r = validate(row)
        self.assertFalse(r["valid"])
        self.assertTrue(_has_error(r, "enum:finish"))

    def test_invalid_price_tier_enum(self):
        row = _base_row(price_tier="ultra_premium")
        r = validate(row)
        self.assertFalse(r["valid"])
        self.assertTrue(_has_error(r, "enum:price_tier"))

    def test_invalid_availability_enum(self):
        row = _base_row(availability="available")
        r = validate(row)
        self.assertFalse(r["valid"])
        self.assertTrue(_has_error(r, "enum:availability"))

    def test_invalid_application_enum_item(self):
        row = _base_row(applications=["countertop", "garage_floor"])
        r = validate(row)
        self.assertFalse(r["valid"])
        self.assertTrue(_has_error(r, "enum:applications contains invalid value 'garage_floor'"))

    def test_empty_applications_array(self):
        row = _base_row(applications=[])
        r = validate(row)
        self.assertFalse(r["valid"])
        self.assertTrue(_has_error(r, "min_items:applications"))

    def test_duplicate_applications(self):
        row = _base_row(applications=["countertop", "countertop"])
        r = validate(row)
        self.assertFalse(r["valid"])
        self.assertTrue(_has_error(r, "unique:applications"))

    def test_unhashable_array_items_return_type_errors_not_exceptions(self):
        cases = {
            "applications": [{"value": "countertop"}],
            "edge_profiles_available": [["eased"]],
            "certifications": [{"name": "NSF_51"}],
            "thickness_options_mm": [[20]],
        }
        for field, value in cases.items():
            with self.subTest(field=field):
                result = validate(_base_row(**{field: value}))
                self.assertFalse(result["valid"])
                self.assertTrue(_has_error(result, f"type:{field} item"))

    def test_confidence_out_of_range_high(self):
        row = _base_row(enrichment_confidence=1.5)
        r = validate(row)
        self.assertFalse(r["valid"])
        self.assertTrue(_has_error(r, "range:enrichment_confidence"))

    def test_confidence_out_of_range_negative(self):
        row = _base_row(enrichment_confidence=-0.1)
        r = validate(row)
        self.assertFalse(r["valid"])
        self.assertTrue(_has_error(r, "range:enrichment_confidence"))

    def test_recycled_content_pct_over_100(self):
        row = _base_row(recycled_content_pct=105)
        r = validate(row)
        self.assertFalse(r["valid"])
        self.assertTrue(_has_error(r, "range:recycled_content_pct"))

    def test_warranty_years_over_25(self):
        row = _base_row(warranty_years=30)
        r = validate(row)
        self.assertFalse(r["valid"])
        self.assertTrue(_has_error(r, "range:warranty_years"))

    def test_invalid_country_code_lowercase(self):
        row = _base_row(country_of_origin="us")
        r = validate(row)
        self.assertFalse(r["valid"])
        self.assertTrue(_has_error(r, "pattern:country_of_origin"))

    def test_invalid_country_code_3_chars(self):
        row = _base_row(country_of_origin="USA")
        r = validate(row)
        self.assertFalse(r["valid"])
        self.assertTrue(_has_error(r, "pattern:country_of_origin"))

    def test_thickness_out_of_range_low(self):
        row = _base_row(thickness_options_mm=[3])
        r = validate(row)
        self.assertFalse(r["valid"])
        self.assertTrue(_has_error(r, "range:thickness_options_mm"))

    def test_thickness_out_of_range_high(self):
        row = _base_row(thickness_options_mm=[65])
        r = validate(row)
        self.assertFalse(r["valid"])
        self.assertTrue(_has_error(r, "range:thickness_options_mm"))

    def test_invalid_edge_profile_enum(self):
        row = _base_row(edge_profiles_available=["eased", "round"])
        r = validate(row)
        self.assertFalse(r["valid"])
        self.assertTrue(_has_error(r, "enum:edge_profiles_available invalid value 'round'"))

    def test_invalid_certification_enum(self):
        row = _base_row(certifications=["GREENGUARD_Gold", "UL_Listed"])
        r = validate(row)
        self.assertFalse(r["valid"])
        self.assertTrue(_has_error(r, "enum:certifications invalid value 'UL_Listed'"))

    def test_product_name_too_long(self):
        row = _base_row(product_name="A" * 121)
        r = validate(row)
        self.assertFalse(r["valid"])
        self.assertTrue(_has_error(r, "length:product_name"))

    def test_is_outdoor_not_bool(self):
        row = _base_row(is_outdoor="yes")
        r = validate(row)
        self.assertFalse(r["valid"])
        self.assertTrue(_has_error(r, "type:is_outdoor"))


# ---------------------------------------------------------------------------
# Cross-field consistency tests
# ---------------------------------------------------------------------------

class TestCrossFieldViolations(unittest.TestCase):

    def test_outdoor_true_requires_weather_rating(self):
        row = _base_row(
            is_outdoor=True,
            weather_rating=None,
            applications=["outdoor_kitchen"],
        )
        r = validate(row)
        self.assertFalse(r["valid"])
        self.assertTrue(_has_error(r, "cross_field:is_outdoor=true but weather_rating is null"))

    def test_outdoor_false_with_outdoor_kitchen_application(self):
        row = _base_row(
            is_outdoor=False,
            weather_rating=None,
            applications=["outdoor_kitchen", "countertop"],
        )
        r = validate(row)
        self.assertFalse(r["valid"])
        self.assertTrue(_has_error(r, "cross_field:is_outdoor=false but 'outdoor_kitchen' is in applications"))

    def test_outdoor_true_with_valid_weather_rating_passes(self):
        row = _base_row(
            is_outdoor=True,
            weather_rating="good",
            applications=["outdoor_kitchen", "countertop"],
        )
        r = validate(row)
        self.assertTrue(r["valid"], f"Errors: {r['errors']}")

    def test_natural_stone_sealing_false_care_low_generates_flag(self):
        row = _base_row(
            material_type="marble",
            sealing_required=False,
            care_level="low",
        )
        r = validate(row)
        # This is a soft flag, not a hard error
        self.assertTrue(r["valid"], f"Should be valid (soft flag only); errors: {r['errors']}")
        self.assertTrue(
            _has_flag(r, "confidence:natural_stone with sealing_required=false"),
            f"Expected natural stone sealing flag; flags: {r['confidence_flags']}"
        )

    def test_quartz_sealing_false_no_flag(self):
        row = _base_row(
            material_type="quartz",
            sealing_required=False,
            care_level="low",
        )
        r = validate(row)
        self.assertTrue(r["valid"])
        self.assertFalse(
            _has_flag(r, "confidence:natural_stone"),
            "Quartz should not trigger the natural stone sealing flag"
        )

    def test_low_confidence_flag_below_0_6(self):
        row = _base_row(enrichment_confidence=0.45)
        r = validate(row)
        self.assertTrue(r["valid"])
        self.assertTrue(_has_flag(r, "low_confidence:enrichment_confidence=0.45"))

    def test_moderate_confidence_flag_between_0_6_and_0_75(self):
        row = _base_row(enrichment_confidence=0.70)
        r = validate(row)
        self.assertTrue(r["valid"])
        self.assertTrue(_has_flag(r, "moderate_confidence:enrichment_confidence=0.70"))

    def test_high_confidence_no_flag(self):
        row = _base_row(enrichment_confidence=0.90)
        r = validate(row)
        self.assertTrue(r["valid"])
        self.assertFalse(any("confidence:enrichment_confidence" in f for f in r["confidence_flags"]))

    def test_model_flagged_fields_propagated(self):
        row = _base_row(
            enrichment_confidence=0.62,
            low_confidence_fields=["warranty_years", "scratch_resistance"],
        )
        r = validate(row)
        self.assertTrue(r["valid"])
        self.assertTrue(_has_flag(r, "model_flagged_fields:warranty_years,scratch_resistance"))

    def test_discontinued_with_certifications_flagged(self):
        row = _base_row(
            availability="discontinued",
            certifications=["NSF_51", "GREENGUARD_Gold"],
        )
        r = validate(row)
        self.assertTrue(r["valid"])
        self.assertTrue(_has_flag(r, "confidence:discontinued product with active certifications"))

    def test_sparse_non_coming_soon_row_flagged(self):
        row = _base_row(
            availability="in_stock",
            manufacturer=None, series_name=None, secondary_color_family=None,
            pattern_type=None, thickness_options_mm=None, weather_rating=None,
            uv_resistant=None, heat_resistance=None, scratch_resistance=None,
            stain_resistant=None, sealing_required=None, care_level=None,
            edge_profiles_available=None, certifications=None,
            recycled_content_pct=None, warranty_years=None, country_of_origin=None,
        )
        r = validate(row)
        self.assertTrue(r["valid"])
        self.assertTrue(_has_flag(r, "sparse_row:"), f"Expected sparse_row flag; flags: {r['confidence_flags']}")

    def test_coming_soon_sparse_not_flagged_for_sparseness(self):
        row = _base_row(
            availability="coming_soon",
            manufacturer=None, series_name=None, secondary_color_family=None,
            pattern_type=None, thickness_options_mm=None, weather_rating=None,
            uv_resistant=None, heat_resistance=None, scratch_resistance=None,
            stain_resistant=None, sealing_required=None, care_level=None,
            edge_profiles_available=None, certifications=None,
            recycled_content_pct=None, warranty_years=None, country_of_origin=None,
        )
        r = validate(row)
        self.assertTrue(r["valid"])
        self.assertFalse(
            _has_flag(r, "sparse_row:"),
            "coming_soon rows are expected to be sparse"
        )


# ---------------------------------------------------------------------------
# Batch validation test
# ---------------------------------------------------------------------------

class TestBatch(unittest.TestCase):

    def test_batch_mixed_results(self):
        rows = [
            _base_row(sku="VALID-001"),
            _base_row(sku="invalid-002"),  # invalid SKU pattern
            _base_row(sku="VALID-003", enrichment_confidence=0.50),  # valid + flag
        ]
        results = validate_batch(rows)
        self.assertEqual(len(results), 3)
        self.assertTrue(results[0]["valid"])
        self.assertFalse(results[1]["valid"])
        self.assertTrue(results[2]["valid"])
        self.assertEqual(results[0]["sku"], "VALID-001")
        self.assertEqual(results[1]["sku"], "invalid-002")
        self.assertEqual(results[0]["row_index"], 0)
        self.assertEqual(results[2]["row_index"], 2)

    def test_batch_empty(self):
        results = validate_batch([])
        self.assertEqual(results, [])


# ---------------------------------------------------------------------------
# 10-row sample run (acceptance criterion)
# ---------------------------------------------------------------------------

SAMPLE_ROWS = [
    # 1 — clean quartz, should PASS
    _base_row(sku="CS-WHT-3200", product_name="Calacatta Snow",
              manufacturer="CaesarStone", material_type="quartz",
              primary_color_family="white", secondary_color_family="gray",
              finish="polished", pattern_type="veined",
              applications=["countertop", "kitchen_island"],
              certifications=["NSF_51", "GREENGUARD_Gold"],
              warranty_years=10, country_of_origin="IL",
              enrichment_confidence=0.92),

    # 2 — outdoor porcelain, should PASS
    _base_row(sku="POL-GRY-OUT-22", product_name="Alpine Concrete Outdoor",
              manufacturer="Florim", material_type="porcelain",
              primary_color_family="gray", finish="matte", pattern_type="solid",
              thickness_options_mm=[20],
              is_outdoor=True, weather_rating="excellent", uv_resistant=True,
              applications=["flooring", "outdoor_kitchen"],
              country_of_origin="IT", enrichment_confidence=0.89),

    # 3 — granite requiring sealing, should PASS
    _base_row(sku="GR-BLK-ABSLT", product_name="Absolute Black Granite",
              material_type="granite", primary_color_family="black",
              finish="polished", pattern_type="solid",
              thickness_options_mm=[20, 30],
              sealing_required=True, care_level="moderate",
              applications=["countertop", "bathroom_vanity"],
              country_of_origin="IN", enrichment_confidence=0.88),

    # 4 — recycled glass, high recycled content, should PASS
    _base_row(sku="RG-TEAL-COAST", product_name="Coastal Tide",
              manufacturer="IceStone", material_type="recycled_glass",
              primary_color_family="blue", secondary_color_family="green",
              finish="polished", pattern_type="speckled",
              applications=["countertop", "backsplash"],
              certifications=["GREENGUARD_Gold", "recycled_content_certified"],
              recycled_content_pct=85,
              availability="made_to_order",
              price_tier="premium", country_of_origin="US",
              enrichment_confidence=0.91),

    # 5 — luxury marble, limited stock, should PASS with flags
    _base_row(sku="MRB-GLD-CLEO", product_name="Cleopatra Gold",
              material_type="marble", primary_color_family="gold",
              secondary_color_family="cream", finish="polished", pattern_type="veined",
              thickness_options_mm=[20, 30],
              sealing_required=True, care_level="high",
              scratch_resistance="low", stain_resistant=False,
              price_tier="luxury", availability="limited_stock",
              country_of_origin="IT",
              enrichment_confidence=0.76,
              low_confidence_fields=["manufacturer", "warranty_years"]),

    # 6 — sintered stone, outdoor, leathered, should PASS
    _base_row(sku="DKTN-DGST-VL", product_name="Dekton Vintage Lava",
              manufacturer="Cosentino", series_name="Dekton",
              material_type="sintered_stone", primary_color_family="black",
              secondary_color_family="gray", finish="leathered", pattern_type="solid",
              thickness_options_mm=[8, 12],
              is_outdoor=True, weather_rating="excellent", uv_resistant=True,
              heat_resistance="excellent", scratch_resistance="excellent",
              stain_resistant=True, sealing_required=False, care_level="low",
              applications=["countertop", "outdoor_kitchen", "flooring"],
              certifications=["GREENGUARD_Gold"],
              warranty_years=25, country_of_origin="ES",
              enrichment_confidence=0.95),

    # 7 — laminate budget, should PASS with no flags
    _base_row(sku="LM-WLNT-245", product_name="Walnut Butcher Block Look",
              manufacturer="Wilsonart", material_type="laminate",
              primary_color_family="brown", finish="matte", pattern_type="linear",
              thickness_options_mm=[13],
              heat_resistance="low", scratch_resistance="moderate",
              sealing_required=False, care_level="low",
              applications=["countertop"],
              warranty_years=1, country_of_origin="US",
              enrichment_confidence=0.93),

    # 8 — travertine outdoor fair rating, should PASS (flag expected: natural stone sealing)
    _base_row(sku="TRV-IVRY-FILL", product_name="Ivory Travertine Filled Honed",
              manufacturer="MSI Stone", material_type="travertine",
              primary_color_family="cream", secondary_color_family="beige",
              finish="honed", pattern_type="organic",
              thickness_options_mm=[13, 20],
              is_outdoor=True, weather_rating="fair", uv_resistant=True,
              heat_resistance="good", scratch_resistance="moderate",
              stain_resistant=False, sealing_required=True, care_level="high",
              applications=["flooring", "wall_cladding", "outdoor_kitchen"],
              price_tier="mid", country_of_origin="TR",
              enrichment_confidence=0.82,
              low_confidence_fields=["warranty_years"]),

    # 9 — FAIL: outdoor=true, weather_rating=null (cross-field violation)
    _base_row(sku="FAIL-NO-WR", product_name="Broken Outdoor Row",
              material_type="porcelain", finish="matte",
              is_outdoor=True,
              weather_rating=None,  # INTENTIONAL FAILURE
              applications=["outdoor_kitchen"],
              enrichment_confidence=0.80),

    # 10 — FAIL: invalid SKU pattern (lowercase)
    _base_row(sku="bad-sku-001", product_name="Bad SKU Row",
              material_type="quartz", primary_color_family="gray",
              enrichment_confidence=0.75),
]

EXPECTED_OUTCOMES = [
    # (row_index, should_be_valid, error_fragment, flag_fragment)
    (0, True, None, None),
    (1, True, None, None),
    (2, True, None, None),
    (3, True, None, None),
    (4, True, None, "model_flagged_fields"),
    (5, True, None, None),
    (6, True, None, None),
    (7, True, None, None),
    (8, False, "cross_field:is_outdoor=true but weather_rating is null", None),
    (9, False, "pattern:sku", None),
]


class TestSampleRun(unittest.TestCase):

    def test_10_row_sample(self):
        results = validate_batch(SAMPLE_ROWS)
        self.assertEqual(len(results), 10)

        for idx, should_pass, err_frag, flag_frag in EXPECTED_OUTCOMES:
            r = results[idx]
            with self.subTest(row_index=idx, sku=r["sku"]):
                if should_pass:
                    self.assertTrue(
                        r["valid"],
                        f"Row {idx} ({r['sku']}) expected PASS; errors: {r['errors']}"
                    )
                else:
                    self.assertFalse(
                        r["valid"],
                        f"Row {idx} ({r['sku']}) expected FAIL but passed"
                    )
                if err_frag:
                    self.assertTrue(
                        _has_error(r, err_frag),
                        f"Row {idx} missing expected error containing '{err_frag}'; got: {r['errors']}"
                    )
                if flag_frag:
                    self.assertTrue(
                        _has_flag(r, flag_frag),
                        f"Row {idx} missing expected flag containing '{flag_frag}'; got: {r['confidence_flags']}"
                    )

    def test_pass_count_correct(self):
        results = validate_batch(SAMPLE_ROWS)
        passed = [r for r in results if r["valid"]]
        failed = [r for r in results if not r["valid"]]
        self.assertEqual(len(passed), 8, f"Expected 8 passing rows, got {len(passed)}")
        self.assertEqual(len(failed), 2, f"Expected 2 failing rows, got {len(failed)}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    for cls in (TestSchemaPass, TestSchemaFail, TestCrossFieldViolations,
                TestBatch, TestSampleRun):
        suite.addTests(loader.loadTestsFromTestCase(cls))
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
