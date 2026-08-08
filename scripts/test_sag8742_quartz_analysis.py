#!/usr/bin/env python3
"""Regression fixture for the approved SAG-8742 Quartz correction."""
from __future__ import annotations

import sqlite3
import tempfile
from decimal import Decimal
from pathlib import Path

from build_sag8351_sqft_account_two_colors import collect


def fixture(path: Path) -> None:
    connection = sqlite3.connect(path)
    connection.executescript("""
      CREATE TABLE CAT_Product (
        ProductID INTEGER, ProductCatalogID INTEGER, MaterialID INTEGER,
        XRefProductID INTEGER, ConsumerDescription TEXT, ColorDescription TEXT,
        Description TEXT, MFRID INTEGER, SquareFootage NUMERIC, SKU TEXT, Inactive INTEGER);
      CREATE TABLE CAT_ProductCatalog (
        ProductCatalogID INTEGER, ProductCatalogCode TEXT, Description TEXT, Inactive INTEGER);
      CREATE TABLE COM_Company (CompanyID INTEGER, CompanyName TEXT, ParentCompanyID INTEGER);
      CREATE TABLE ORD_RetailOrder (RetailOrderID INTEGER, RODate TEXT, OrderStatusID INTEGER, DealerCompanyID INTEGER);
      CREATE TABLE ORD_ROProduct (ROProductID INTEGER, RetailOrderID INTEGER, ProductID INTEGER, DealerQty NUMERIC);
      CREATE TABLE ORD_MaterialOrder (MaterialOrderID INTEGER, MODate TEXT, OrderStatusID INTEGER, CompanyID INTEGER);
      CREATE TABLE ORD_MOProduct (MOProductID INTEGER, MaterialOrderID INTEGER, ProductID INTEGER, Quantity NUMERIC);
      CREATE TABLE ORD_PurchaseOrder (PurchaseOrderID INTEGER, MaterialOrderID INTEGER, CreatedOn TEXT, OrderStatusID INTEGER);
      CREATE TABLE ORD_POProduct (POProductID INTEGER, PurchaseOrderID INTEGER, ProductID INTEGER, QtyOrdered NUMERIC);
    """)
    connection.executemany("INSERT INTO CAT_ProductCatalog VALUES (?,?,?,?)", [
        (1, "HOUSE", "House", 0), (2, "RETAIL-A", "Retail A", 0), (3, "RETAIL-B", "Retail B", 0),
    ])
    connection.executemany("INSERT INTO CAT_Product VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
        (100, 1, 2510, None, "Material A", "A", "Material A", 77, 5, "Q-A", 0),
        (101, 1, 2510, None, "Material Z", "Z", "Material Z", None, 5, "Q-Z", 0),
        (102, 1, 2510, None, "No SF", "N", "No SF", None, None, "Q-N", 0),
        (200, 2, None, 100, "Retail White", None, "Retail Alias A", None, None, "R-A", 0),
        (201, 3, None, 100, "Retail White Variant", None, "Retail Alias B", None, None, "R-B", 0),
        (202, 2, None, 102, "Retail Missing SF", None, "Retail Missing SF", None, None, "R-N", 0),
    ])
    connection.executemany("INSERT INTO COM_Company VALUES (?,?,?)", [
        (1, "Source dealer", 10), (2, "Fallback company", None), (10, "Parent company", None), (77, "Maker", None),
    ])
    connection.executemany("INSERT INTO ORD_RetailOrder VALUES (?,?,?,?)", [
        (1, "2024-01-01", 1, 1), (2, "2024-01-02", 1, 1),
    ])
    connection.executemany("INSERT INTO ORD_ROProduct VALUES (?,?,?,?)", [(1, 1, 200, 10), (2, 2, 202, 7)])
    connection.executemany("INSERT INTO ORD_MaterialOrder VALUES (?,?,?,?)", [(2, "2024-01-01", 1, 1), (3, "2024-01-01", 1, 2)])
    connection.executemany("INSERT INTO ORD_MOProduct VALUES (?,?,?,?)", [(2, 2, 100, 2)])
    connection.executemany("INSERT INTO ORD_PurchaseOrder VALUES (?,?,?,?)", [(3, 3, "2024-01-01", 1)])
    connection.execute("INSERT INTO ORD_POProduct VALUES (?,?,?,?)", (3, 3, 100, 3))
    connection.commit()
    connection.close()


def main() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        database = Path(temporary) / "fixture.db"
        fixture(database)
        detail, annual, lineage, crossover, manufacturer, coverage = collect(database)

    totals = {lane: sum((row["calculated_measure"] for row in annual if row["lane"] == lane), Decimal(0)) for lane in ("RO", "MO", "PO")}
    assert totals == {"RO": Decimal("10"), "MO": Decimal("10"), "PO": Decimal("15")}, totals
    assert any(row["lane"] == "RO" and row["exclusion_reason"] == "Non-positive DealerQty or reportability SquareFootage" and row["source_native_quantity"] == Decimal("7") for row in coverage)
    assert all(row["parent_company_id"] == 10 and row["parent_company_name"] == "Parent company" for row in detail if row["source_company_id"] == 1)
    assert any(row["source_company_id"] == 2 and row["parent_company_id"] == 2 and row["parent_is_source_company"] for row in lineage)
    ambiguous = [row for row in crossover if row["material_product_id"] == 100]
    assert len(ambiguous) == 2 and {row["retail_catalog_id"] for row in ambiguous} == {2, 3}
    assert all(row["mapping_status"] == "Ambiguous" and row["candidate_count"] == 2 for row in ambiguous)
    unmatched = [row for row in crossover if row["material_product_id"] == 101]
    assert len(unmatched) == 1 and unmatched[0]["mapping_status"] == "Unmatched" and unmatched[0]["candidate_count"] == 0
    assert manufacturer == [{"source_product_id": 100, "source_sku": "Q-A", "mfr_id": 77, "manufacturer_company_id": 77, "manufacturer_company_name": "Maker", "affected_po_line_count": 1, "calculated_po_measure": Decimal("15"), "mapping_status": "Matched"}]
    print("SAG-8742 fixture tests passed")


if __name__ == "__main__":
    main()
