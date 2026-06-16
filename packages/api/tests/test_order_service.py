"""Tests for order service — snapshot, totals, and D365 field mapping."""

from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.services.order_service import (
    MAX_RETRY_COUNT,
    ORDER_STATUSES,
    calculate_order_total,
    snapshot_quote_items,
)
from app.services.d365_service import _map_to_d365_opportunity


# ---------------------------------------------------------------------------
# snapshot_quote_items
# ---------------------------------------------------------------------------


class TestSnapshotQuoteItems:
    def _make_item(self, **overrides):
        defaults = {
            "id": "item-1",
            "room": "Kitchen",
            "trade_category": "plumbing",
            "description": "Replace kitchen sink",
            "sage_sku": "SKU-001",
            "quantity": 2,
            "unit_cost": Decimal("100.00"),
            "labor_cost": Decimal("50.00"),
            "markup_pct": Decimal("10.00"),
            "subtotal": Decimal("275.00"),
            "unit_of_measure": "each",
        }
        defaults.update(overrides)
        return SimpleNamespace(**defaults)

    def test_basic_snapshot(self):
        items = [self._make_item()]
        result = snapshot_quote_items(items)
        assert len(result) == 1
        snap = result[0]
        assert snap["quote_item_id"] == "item-1"
        assert snap["room"] == "Kitchen"
        assert snap["sage_sku"] == "SKU-001"
        assert snap["quantity"] == 2
        assert snap["subtotal"] == Decimal("275.00")

    def test_multiple_items(self):
        items = [
            self._make_item(id="item-1", room="Kitchen"),
            self._make_item(id="item-2", room="Bathroom", sage_sku="SKU-002"),
            self._make_item(id="item-3", room="Bedroom", sage_sku=None),
        ]
        result = snapshot_quote_items(items)
        assert len(result) == 3
        assert result[0]["room"] == "Kitchen"
        assert result[1]["room"] == "Bathroom"
        assert result[2]["sage_sku"] is None

    def test_empty_items(self):
        assert snapshot_quote_items([]) == []

    def test_none_quantity_defaults(self):
        item = self._make_item(quantity=None)
        result = snapshot_quote_items([item])
        assert result[0]["quantity"] == 1

    def test_preserves_all_fields(self):
        item = self._make_item()
        snap = snapshot_quote_items([item])[0]
        expected_keys = {
            "quote_item_id", "room", "trade_category", "description",
            "sage_sku", "quantity", "unit_cost", "labor_cost",
            "markup_pct", "subtotal", "unit_of_measure",
        }
        assert set(snap.keys()) == expected_keys


# ---------------------------------------------------------------------------
# calculate_order_total
# ---------------------------------------------------------------------------


class TestCalculateOrderTotal:
    def test_basic_total(self):
        items = [
            {"subtotal": Decimal("100.00")},
            {"subtotal": Decimal("200.50")},
        ]
        assert calculate_order_total(items) == Decimal("300.50")

    def test_empty_items(self):
        assert calculate_order_total([]) == Decimal("0.00")

    def test_none_subtotals_skipped(self):
        items = [
            {"subtotal": Decimal("150.00")},
            {"subtotal": None},
            {"subtotal": Decimal("50.00")},
        ]
        assert calculate_order_total(items) == Decimal("200.00")

    def test_string_subtotals(self):
        items = [{"subtotal": "99.99"}, {"subtotal": "0.01"}]
        assert calculate_order_total(items) == Decimal("100.00")

    def test_single_item(self):
        assert calculate_order_total([{"subtotal": Decimal("1234.56")}]) == Decimal("1234.56")

    def test_large_total(self):
        items = [{"subtotal": Decimal("99999.99")} for _ in range(10)]
        assert calculate_order_total(items) == Decimal("999999.90")

    def test_quantize_precision(self):
        items = [{"subtotal": Decimal("33.333")}]
        result = calculate_order_total(items)
        assert str(result) == "33.33"


# ---------------------------------------------------------------------------
# ORDER_STATUSES constant
# ---------------------------------------------------------------------------


class TestOrderStatuses:
    def test_has_required_statuses(self):
        required = {"pending", "submitted", "confirmed", "shipped", "delivered", "failed", "cancelled"}
        assert required.issubset(set(ORDER_STATUSES))

    def test_max_retry_count(self):
        assert MAX_RETRY_COUNT == 3


# ---------------------------------------------------------------------------
# D365 field mapping
# ---------------------------------------------------------------------------


class TestD365FieldMapping:
    def test_basic_mapping(self):
        order_data = {
            "id": "order-123",
            "quote_id": "quote-456",
            "sage_order_id": "SAGE-789",
            "total_amount": Decimal("5000.00"),
        }
        property_data = {
            "id": "prop-abc",
            "address": "123 Main St",
            "city": "Austin",
            "state": "TX",
            "zip": "78701",
            "property_type": "Single Family",
            "sqft": 1800,
            "beds": 3,
            "baths": 2.0,
            "arv_estimate": Decimal("250000"),
        }
        result = _map_to_d365_opportunity(order_data, property_data)
        assert "GCP Renovation" in result["name"]
        assert "123 Main St" in result["name"]
        assert result["estimatedvalue"] == 5000.0
        assert "order-123" in result["description"]
        assert result["new_gcp_property_id"] == "prop-abc"
        assert result["new_gcp_sage_order_id"] == "SAGE-789"
        assert result["new_gcp_arv_estimate"] == 250000.0

    def test_mapping_without_property(self):
        order_data = {"id": "order-123", "quote_id": "q-1", "total_amount": Decimal("1000")}
        result = _map_to_d365_opportunity(order_data, None)
        assert "GCP Order order-123" in result["name"]
        assert result["estimatedvalue"] == 1000.0
        # No property custom fields
        assert "new_gcp_property_id" not in result

    def test_mapping_without_total(self):
        order_data = {"id": "order-1", "quote_id": "q-1", "total_amount": None}
        result = _map_to_d365_opportunity(order_data)
        assert result["estimatedvalue"] is None

    def test_name_length_limit(self):
        order_data = {"id": "order-1", "quote_id": "q-1", "total_amount": None}
        property_data = {
            "address": "A" * 500,
            "city": "City",
            "state": "ST",
            "zip": "00000",
        }
        result = _map_to_d365_opportunity(order_data, property_data)
        assert len(result["name"]) <= 300

    def test_description_includes_property_details(self):
        order_data = {"id": "o-1", "quote_id": "q-1", "total_amount": None}
        property_data = {
            "address": "456 Oak Ave",
            "city": "Dallas",
            "state": "TX",
            "zip": "75201",
            "property_type": "Duplex",
            "sqft": 2400,
            "beds": 4,
            "baths": 3.0,
        }
        result = _map_to_d365_opportunity(order_data, property_data)
        assert "456 Oak Ave" in result["description"]
        assert "Duplex" in result["description"]
        assert "2400" in result["description"]

    def test_custom_fields_prefix(self):
        order_data = {"id": "o-1", "quote_id": "q-1", "sage_order_id": "S-1", "total_amount": None}
        property_data = {"id": "p-1", "address": "x", "city": "c", "state": "s", "zip": "0", "arv_estimate": 100}
        result = _map_to_d365_opportunity(order_data, property_data)
        # All custom fields should use new_ prefix
        custom_keys = [k for k in result if k.startswith("new_")]
        assert len(custom_keys) >= 3


# ---------------------------------------------------------------------------
# Integration: snapshot → total pipeline
# ---------------------------------------------------------------------------


class TestOrderCreationPipeline:
    def test_snapshot_to_total(self):
        items = [
            SimpleNamespace(
                id="i1", room="Kitchen", trade_category="plumbing",
                description="Fix sink", sage_sku="SK-1", quantity=2,
                unit_cost=Decimal("80"), labor_cost=Decimal("40"),
                markup_pct=None, subtotal=Decimal("200"), unit_of_measure="each",
            ),
            SimpleNamespace(
                id="i2", room="Bathroom", trade_category="tile",
                description="Retile floor", sage_sku="SK-2", quantity=50,
                unit_cost=Decimal("8"), labor_cost=Decimal("300"),
                markup_pct=Decimal("10"), subtotal=Decimal("770"),
                unit_of_measure="sqft",
            ),
        ]
        snapshots = snapshot_quote_items(items)
        total = calculate_order_total(snapshots)
        assert total == Decimal("970.00")
        assert len(snapshots) == 2
        assert snapshots[0]["quantity"] == 2
        assert snapshots[1]["sage_sku"] == "SK-2"
