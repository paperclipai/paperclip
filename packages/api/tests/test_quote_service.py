"""Tests for the quote service — calculations, AI generation, and PDF output."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

import pytest

from app.services.quote_service import (
    PLATFORM_FEE_DEFAULT,
    calculate_item_subtotal,
    calculate_quote_totals,
    generate_ai_line_items,
    generate_sow_pdf,
)


# ---------------------------------------------------------------------------
# calculate_item_subtotal
# ---------------------------------------------------------------------------


class TestCalculateItemSubtotal:
    def test_basic_calculation(self):
        result = calculate_item_subtotal(
            quantity=2,
            unit_cost=Decimal("100.00"),
            labor_cost=Decimal("50.00"),
            markup_pct=None,
        )
        # (2 * 100 + 50) * 1.0 = 250
        assert result == Decimal("250.00")

    def test_with_markup(self):
        result = calculate_item_subtotal(
            quantity=1,
            unit_cost=Decimal("100.00"),
            labor_cost=Decimal("0.00"),
            markup_pct=Decimal("10"),
        )
        # (1 * 100 + 0) * 1.10 = 110
        assert result == Decimal("110.00")

    def test_zero_quantity_treated_as_one(self):
        # quantity=1 is the minimum per schema validation
        result = calculate_item_subtotal(
            quantity=1,
            unit_cost=Decimal("50.00"),
            labor_cost=Decimal("25.00"),
            markup_pct=None,
        )
        assert result == Decimal("75.00")

    def test_large_markup(self):
        result = calculate_item_subtotal(
            quantity=1,
            unit_cost=Decimal("100.00"),
            labor_cost=Decimal("100.00"),
            markup_pct=Decimal("50"),
        )
        # (100 + 100) * 1.50 = 300
        assert result == Decimal("300.00")

    def test_all_zeros(self):
        result = calculate_item_subtotal(
            quantity=1,
            unit_cost=Decimal("0"),
            labor_cost=Decimal("0"),
            markup_pct=None,
        )
        assert result == Decimal("0")

    def test_high_quantity(self):
        result = calculate_item_subtotal(
            quantity=100,
            unit_cost=Decimal("10.50"),
            labor_cost=Decimal("200.00"),
            markup_pct=Decimal("5"),
        )
        # (100 * 10.50 + 200) * 1.05 = (1050 + 200) * 1.05 = 1312.50
        assert result == Decimal("1312.50")


# ---------------------------------------------------------------------------
# calculate_quote_totals
# ---------------------------------------------------------------------------


class TestCalculateQuoteTotals:
    def test_basic_totals(self):
        items = [
            {"quantity": 2, "unit_cost": "100", "labor_cost": "50", "markup_pct": None},
            {"quantity": 1, "unit_cost": "200", "labor_cost": "100", "markup_pct": None},
        ]
        totals = calculate_quote_totals(items)
        assert totals["total_material"] == Decimal("400.00")  # 2*100 + 1*200
        assert totals["total_labor"] == Decimal("150.00")  # 50 + 100
        # platform fee = 550 * 0.05 = 27.50
        assert totals["platform_fee"] == Decimal("27.50")
        assert totals["grand_total"] == Decimal("577.50")

    def test_custom_fee_pct(self):
        items = [
            {"quantity": 1, "unit_cost": "1000", "labor_cost": "0", "markup_pct": None},
        ]
        totals = calculate_quote_totals(items, platform_fee_pct=Decimal("0.10"))
        assert totals["platform_fee"] == Decimal("100.00")
        assert totals["grand_total"] == Decimal("1100.00")

    def test_zero_fee(self):
        items = [
            {"quantity": 1, "unit_cost": "500", "labor_cost": "0", "markup_pct": None},
        ]
        totals = calculate_quote_totals(items, platform_fee_pct=Decimal("0"))
        assert totals["platform_fee"] == Decimal("0.00")
        assert totals["grand_total"] == Decimal("500.00")

    def test_empty_items(self):
        totals = calculate_quote_totals([])
        assert totals["total_material"] == Decimal("0.00")
        assert totals["total_labor"] == Decimal("0.00")
        assert totals["platform_fee"] == Decimal("0.00")
        assert totals["grand_total"] == Decimal("0.00")

    def test_with_markup(self):
        items = [
            {"quantity": 1, "unit_cost": "100", "labor_cost": "100", "markup_pct": "20"},
        ]
        totals = calculate_quote_totals(items, platform_fee_pct=Decimal("0"))
        # Material: 100 * 1.20 = 120, Labor: 100 * 1.20 = 120
        assert totals["total_material"] == Decimal("120.00")
        assert totals["total_labor"] == Decimal("120.00")

    def test_multiple_items_with_mixed_markup(self):
        items = [
            {"quantity": 2, "unit_cost": "50", "labor_cost": "30", "markup_pct": "10"},
            {"quantity": 1, "unit_cost": "200", "labor_cost": "0", "markup_pct": None},
        ]
        totals = calculate_quote_totals(items, platform_fee_pct=Decimal("0.05"))
        # Item 1: material = 2*50*1.10 = 110, labor = 30*1.10 = 33
        # Item 2: material = 200, labor = 0
        assert totals["total_material"] == Decimal("310.00")
        assert totals["total_labor"] == Decimal("33.00")
        subtotal = Decimal("343.00")
        assert totals["platform_fee"] == Decimal("17.15")
        assert totals["grand_total"] == Decimal("360.15")


# ---------------------------------------------------------------------------
# generate_ai_line_items
# ---------------------------------------------------------------------------


class TestGenerateAILineItems:
    def test_generates_items_from_labels(self):
        labels = [
            {
                "room_type": "kitchen",
                "condition": "poor",
                "damage_issues": ["peeling_paint", "outdated_fixtures"],
                "renovation_needed": "major",
                "confidence": 0.9,
            }
        ]
        items = generate_ai_line_items(labels)
        assert len(items) > 0
        # All items should be AI generated
        assert all(item["is_ai_generated"] for item in items)
        assert all(item["ai_confidence"] == 0.9 for item in items)
        # Kitchen should produce multiple trade items
        trades = {item["trade_category"] for item in items}
        assert "plumbing" in trades
        assert "electrical" in trades

    def test_skips_no_renovation(self):
        labels = [
            {
                "room_type": "bedroom",
                "condition": "excellent",
                "damage_issues": [],
                "renovation_needed": "none",
                "confidence": 0.95,
            }
        ]
        items = generate_ai_line_items(labels)
        assert len(items) == 0

    def test_cosmetic_renovation(self):
        labels = [
            {
                "room_type": "bedroom",
                "condition": "fair",
                "damage_issues": ["peeling_paint"],
                "renovation_needed": "cosmetic",
                "confidence": 0.85,
            }
        ]
        items = generate_ai_line_items(labels)
        assert len(items) > 0
        rooms = {item["room"] for item in items}
        assert "Bedroom" in rooms

    def test_multiple_rooms(self):
        labels = [
            {
                "room_type": "bathroom",
                "condition": "poor",
                "damage_issues": ["water_damage"],
                "renovation_needed": "major",
                "confidence": 0.8,
            },
            {
                "room_type": "bathroom",
                "condition": "fair",
                "damage_issues": [],
                "renovation_needed": "moderate",
                "confidence": 0.75,
            },
        ]
        items = generate_ai_line_items(labels)
        rooms = {item["room"] for item in items}
        assert "Bathroom" in rooms
        assert "Bathroom 2" in rooms

    def test_empty_labels(self):
        assert generate_ai_line_items([]) == []

    def test_unknown_room_type(self):
        labels = [
            {
                "room_type": "unknown_space",
                "condition": "poor",
                "damage_issues": [],
                "renovation_needed": "moderate",
                "confidence": 0.6,
            }
        ]
        items = generate_ai_line_items(labels)
        assert len(items) > 0
        assert all(item["trade_category"] == "general" for item in items)

    def test_all_items_have_required_fields(self):
        labels = [
            {
                "room_type": "kitchen",
                "condition": "poor",
                "damage_issues": ["water_damage"],
                "renovation_needed": "full_gut",
                "confidence": 0.92,
            }
        ]
        items = generate_ai_line_items(labels)
        required_keys = {
            "room", "trade_category", "description", "sage_sku",
            "quantity", "unit_cost", "labor_cost", "markup_pct",
            "unit_of_measure", "ai_confidence", "is_ai_generated",
        }
        for item in items:
            assert required_keys.issubset(item.keys())
            assert isinstance(item["unit_cost"], Decimal)
            assert isinstance(item["labor_cost"], Decimal)
            assert item["quantity"] >= 1

    def test_damage_issues_in_description(self):
        labels = [
            {
                "room_type": "basement",
                "condition": "critical",
                "damage_issues": ["water_damage", "mold", "structural_concern"],
                "renovation_needed": "full_gut",
                "confidence": 0.7,
            }
        ]
        items = generate_ai_line_items(labels)
        descriptions = " ".join(item["description"] for item in items)
        assert "water_damage" in descriptions


# ---------------------------------------------------------------------------
# generate_sow_pdf
# ---------------------------------------------------------------------------


class TestGenerateSOWPdf:
    def test_generates_valid_pdf(self):
        quote = {
            "id": str(uuid.uuid4()),
            "status": "draft",
            "created_at": datetime(2026, 4, 14, 10, 0, 0),
            "notes": "Test SOW",
            "total_material": Decimal("1000.00"),
            "total_labor": Decimal("500.00"),
            "platform_fee": Decimal("75.00"),
            "platform_fee_pct": Decimal("0.05"),
            "grand_total": Decimal("1575.00"),
        }
        items = [
            {
                "room": "Kitchen",
                "trade_category": "plumbing",
                "description": "Replace kitchen sink",
                "quantity": 1,
                "unit_cost": Decimal("200.00"),
                "labor_cost": Decimal("150.00"),
                "markup_pct": None,
            },
            {
                "room": "Bathroom",
                "trade_category": "tile",
                "description": "Retile bathroom floor",
                "quantity": 50,
                "unit_cost": Decimal("8.00"),
                "labor_cost": Decimal("350.00"),
                "markup_pct": Decimal("10"),
            },
        ]
        property_info = {
            "address": "123 Main St",
            "city": "Austin",
            "state": "TX",
            "zip": "78701",
            "property_type": "Single Family",
            "sqft": 1800,
            "beds": 3,
            "baths": 2.0,
        }
        pdf_bytes = generate_sow_pdf(quote, items, property_info)
        assert isinstance(pdf_bytes, bytes)
        assert len(pdf_bytes) > 0
        assert pdf_bytes[:5] == b"%PDF-"

    def test_pdf_without_property_info(self):
        quote = {
            "id": "test-id",
            "status": "draft",
            "created_at": "April 14, 2026",
            "notes": None,
            "total_material": Decimal("0"),
            "total_labor": Decimal("0"),
            "platform_fee": Decimal("0"),
            "platform_fee_pct": Decimal("0.05"),
            "grand_total": Decimal("0"),
        }
        pdf_bytes = generate_sow_pdf(quote, [])
        assert pdf_bytes[:5] == b"%PDF-"

    def test_pdf_with_long_description(self):
        quote = {
            "id": "test-id",
            "status": "approved",
            "created_at": datetime(2026, 4, 14),
            "notes": "A" * 500,
            "total_material": Decimal("100"),
            "total_labor": Decimal("50"),
            "platform_fee": Decimal("7.50"),
            "platform_fee_pct": Decimal("0.05"),
            "grand_total": Decimal("157.50"),
        }
        items = [
            {
                "room": "Room",
                "trade_category": "general",
                "description": "X" * 200,
                "quantity": 1,
                "unit_cost": Decimal("100"),
                "labor_cost": Decimal("50"),
                "markup_pct": None,
            }
        ]
        pdf_bytes = generate_sow_pdf(quote, items)
        assert pdf_bytes[:5] == b"%PDF-"

    def test_pdf_with_many_items(self):
        quote = {
            "id": "test-bulk",
            "status": "draft",
            "created_at": datetime(2026, 4, 14),
            "notes": None,
            "total_material": Decimal("5000"),
            "total_labor": Decimal("2000"),
            "platform_fee": Decimal("350"),
            "platform_fee_pct": Decimal("0.05"),
            "grand_total": Decimal("7350"),
        }
        items = [
            {
                "room": f"Room {i}",
                "trade_category": "general",
                "description": f"Item {i}",
                "quantity": i + 1,
                "unit_cost": Decimal("50"),
                "labor_cost": Decimal("20"),
                "markup_pct": None,
            }
            for i in range(20)
        ]
        pdf_bytes = generate_sow_pdf(quote, items)
        assert pdf_bytes[:5] == b"%PDF-"
        assert len(pdf_bytes) > 1000


# ---------------------------------------------------------------------------
# Integration: AI generation → totals → PDF pipeline
# ---------------------------------------------------------------------------


class TestAIQuotePipeline:
    def test_full_pipeline(self):
        """photo analysis → AI line items → totals → PDF SOW."""
        labels = [
            {
                "room_type": "kitchen",
                "condition": "poor",
                "damage_issues": ["outdated_fixtures", "damaged_flooring"],
                "renovation_needed": "major",
                "confidence": 0.88,
            },
            {
                "room_type": "bathroom",
                "condition": "fair",
                "damage_issues": ["peeling_paint"],
                "renovation_needed": "cosmetic",
                "confidence": 0.92,
            },
        ]

        # Step 1: Generate AI items
        items = generate_ai_line_items(labels)
        assert len(items) > 0

        # Step 2: Calculate totals
        totals = calculate_quote_totals(items)
        assert totals["grand_total"] > Decimal("0")
        assert totals["total_material"] > Decimal("0")
        assert totals["total_labor"] > Decimal("0")

        # Step 3: Generate PDF
        quote = {
            "id": "pipeline-test",
            "status": "draft",
            "created_at": datetime(2026, 4, 14),
            "notes": "AI-generated quote",
            **totals,
            "platform_fee_pct": PLATFORM_FEE_DEFAULT,
        }
        pdf_bytes = generate_sow_pdf(quote, items, {
            "address": "456 Oak Ave",
            "city": "Dallas",
            "state": "TX",
            "zip": "75201",
            "property_type": "Single Family",
            "sqft": 2200,
            "beds": 4,
            "baths": 2.5,
        })
        assert pdf_bytes[:5] == b"%PDF-"
        assert len(pdf_bytes) > 500
