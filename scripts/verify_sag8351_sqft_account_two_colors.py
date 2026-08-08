#!/usr/bin/env python3
"""Independent read-only source replay and package verifier for SAG-8742."""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sqlite3
import zipfile
from collections import Counter, defaultdict
from decimal import Decimal
from pathlib import Path

from openpyxl import load_workbook

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data/2026-08-05/sag-8483/sage_extract.db"
START, END = "2023-08-04", "2026-08-04"
EXPECTED_RO = {"cohort_count": 58056, "cohort_total": Decimal("2557013.560"), "reportable_count": 48098, "reportable_total": Decimal("2061862.510"), "excluded_count": 9958, "excluded_total": Decimal("495151.050")}
PACKAGE_FILES = {"Sage_Quartz_Corrected_Parent_Color_Lane.xlsx", "annual_parent_year_color_lane.csv", "parent_company_lineage.csv", "retail_catalog_color_crossover.csv", "house_po_sku_manufacturer.csv", "coverage.csv", "query_receipt.sql", "validation.json", "README.md"}
SHEETS = ["Parent Color Year Detail", "Annual Parent Rollup", "Parent Company Lineage", "Retail Catalog Crossover", "House PO SKU Manufacturer", "Coverage", "Methodology"]


def decimal(value: object) -> Decimal:
    return Decimal(str(value if value not in (None, "") else 0))


def clean(value: object) -> str:
    return "" if value is None else str(value).strip()


def color(row: sqlite3.Row) -> str:
    return clean(row["ColorDescription"]) or clean(row["ConsumerDescription"]) or clean(row["Description"]) or "(blank material color)"


def open_source() -> sqlite3.Connection:
    connection = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


# Deliberately separate from the generator: this SQL is the verifier's own replay contract.
SQL = {
    "RO": """
      SELECT r.ROProductID source_line_id, ro.RODate source_date, r.DealerQty native_quantity,
             COALESCE(rp.SquareFootage,h.SquareFootage) reportability_square_footage,
             CASE WHEN rp.MaterialID=2510 THEN rp.ProductID ELSE h.ProductID END material_product_id,
             CASE WHEN rp.MaterialID=2510 THEN rp.ColorDescription ELSE h.ColorDescription END ColorDescription,
             CASE WHEN rp.MaterialID=2510 THEN rp.ConsumerDescription ELSE h.ConsumerDescription END ConsumerDescription,
             CASE WHEN rp.MaterialID=2510 THEN rp.Description ELSE h.Description END Description,
             ro.DealerCompanyID source_company_id, sc.CompanyName source_company_name,
             COALESCE(sc.ParentCompanyID,sc.CompanyID) parent_company_id,
             COALESCE(pc.CompanyName,sc.CompanyName,'[UNASSIGNED COMPANY]') parent_company_name
      FROM ORD_ROProduct r JOIN ORD_RetailOrder ro ON ro.RetailOrderID=r.RetailOrderID
      LEFT JOIN CAT_Product rp ON rp.ProductID=r.ProductID
      LEFT JOIN CAT_Product h ON h.ProductID=rp.XRefProductID AND h.ProductCatalogID=1 AND h.MaterialID=2510
      LEFT JOIN COM_Company sc ON sc.CompanyID=ro.DealerCompanyID
      LEFT JOIN COM_Company pc ON pc.CompanyID=COALESCE(sc.ParentCompanyID,sc.CompanyID)
      WHERE date(ro.RODate)>=? AND date(ro.RODate)<? AND ro.OrderStatusID<>40
        AND (rp.MaterialID=2510 OR h.ProductID IS NOT NULL)
    """,
    "MO": """
      SELECT m.MOProductID source_line_id, mo.MODate source_date, m.Quantity native_quantity, mp.SquareFootage reportability_square_footage,
             mp.ProductID material_product_id, mp.ColorDescription, mp.ConsumerDescription, mp.Description,
             mo.CompanyID source_company_id, sc.CompanyName source_company_name, COALESCE(sc.ParentCompanyID,sc.CompanyID) parent_company_id,
             COALESCE(pc.CompanyName,sc.CompanyName,'[UNASSIGNED COMPANY]') parent_company_name
      FROM ORD_MOProduct m JOIN ORD_MaterialOrder mo ON mo.MaterialOrderID=m.MaterialOrderID
      JOIN CAT_Product mp ON mp.ProductID=m.ProductID AND mp.MaterialID=2510
      LEFT JOIN COM_Company sc ON sc.CompanyID=mo.CompanyID LEFT JOIN COM_Company pc ON pc.CompanyID=COALESCE(sc.ParentCompanyID,sc.CompanyID)
      WHERE date(mo.MODate)>=? AND date(mo.MODate)<? AND mo.OrderStatusID<>40
    """,
    "PO": """
      SELECT p.POProductID source_line_id, po.CreatedOn source_date, p.QtyOrdered native_quantity, mp.SquareFootage reportability_square_footage,
             mp.ProductID material_product_id, mp.ColorDescription, mp.ConsumerDescription, mp.Description,
             mo.CompanyID source_company_id, sc.CompanyName source_company_name, COALESCE(sc.ParentCompanyID,sc.CompanyID) parent_company_id,
             COALESCE(pc.CompanyName,sc.CompanyName,'[UNASSIGNED COMPANY]') parent_company_name
      FROM ORD_POProduct p JOIN ORD_PurchaseOrder po ON po.PurchaseOrderID=p.PurchaseOrderID
      LEFT JOIN ORD_MaterialOrder mo ON mo.MaterialOrderID=po.MaterialOrderID
      JOIN CAT_Product mp ON mp.ProductID=p.ProductID AND mp.MaterialID=2510
      LEFT JOIN COM_Company sc ON sc.CompanyID=mo.CompanyID LEFT JOIN COM_Company pc ON pc.CompanyID=COALESCE(sc.ParentCompanyID,sc.CompanyID)
      WHERE date(po.CreatedOn)>=? AND date(po.CreatedOn)<? AND po.OrderStatusID<>40
    """,
}


def classified(lane: str, row: sqlite3.Row) -> tuple[bool, Decimal]:
    quantity, square_footage = decimal(row["native_quantity"]), decimal(row["reportability_square_footage"])
    if lane == "RO":
        return quantity > 0 and square_footage > 0, quantity
    return quantity > 0 and square_footage > 0, quantity * square_footage


def replay(connection: sqlite3.Connection) -> dict[str, dict]:
    results: dict[str, dict] = {}
    for lane, query in SQL.items():
        rows = list(connection.execute(query, (START, END)))
        reportable = []
        aggregates: dict[tuple, Decimal] = defaultdict(Decimal)
        for row in rows:
            valid, measure = classified(lane, row)
            if valid:
                reportable.append((row, measure))
                aggregates[(clean(row["source_date"])[:4], lane, row["parent_company_id"], clean(row["parent_company_name"]), row["material_product_id"], color(row))] += measure
        results[lane] = {"rows": rows, "reportable": reportable, "aggregates": aggregates, "cohort_count": len(rows), "cohort_total": sum((classified(lane, row)[1] for row in rows), Decimal(0)), "reportable_count": len(reportable), "reportable_total": sum((measure for _, measure in reportable), Decimal(0))}
    ro = results["RO"]
    ro["excluded_count"] = ro["cohort_count"] - ro["reportable_count"]
    ro["excluded_total"] = ro["cohort_total"] - ro["reportable_total"]
    return results


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def nullable_int(value: str) -> int | None:
    return int(value) if value not in (None, "") else None


def independent_candidates(connection: sqlite3.Connection) -> tuple[list[tuple], set[int]]:
    materials = {row[0] for row in connection.execute("SELECT ProductID FROM CAT_Product WHERE MaterialID=2510")}
    candidates = [tuple(row) for row in connection.execute("""
      SELECT r.XRefProductID, r.ProductID, r.ProductCatalogID, r.ConsumerDescription
      FROM CAT_Product r JOIN CAT_ProductCatalog c ON c.ProductCatalogID=r.ProductCatalogID
      JOIN CAT_Product m ON m.ProductID=r.XRefProductID AND m.MaterialID=2510
      WHERE r.XRefProductID IS NOT NULL AND COALESCE(r.Inactive,0)=0 AND COALESCE(c.Inactive,0)=0
        AND TRIM(COALESCE(r.ConsumerDescription,''))<>''
      GROUP BY r.XRefProductID,r.ProductID,r.ProductCatalogID,r.ConsumerDescription
      ORDER BY r.XRefProductID,r.ProductID,r.ProductCatalogID,r.ConsumerDescription
    """)]
    return candidates, materials


def validate_workbook(path: Path, annual: list[dict[str, str]]) -> int:
    workbook = load_workbook(path, read_only=False, data_only=False)
    if workbook.sheetnames != SHEETS:
        raise SystemExit(f"workbook sheets differ: {workbook.sheetnames}")
    detail_headers = [cell.value for cell in workbook["Parent Color Year Detail"][1]]
    for required in ("Lane", "Parent Company ID", "Parent Company Name", "Source Company ID", "Source Company Name", "Calculated Measure"):
        if required not in detail_headers:
            raise SystemExit(f"workbook detail header missing {required}")
    summary = workbook["Annual Parent Rollup"]
    if summary.max_row != len(annual) + 1:
        raise SystemExit("workbook annual summary row count differs from annual CSV")
    if any(not isinstance(summary.cell(row, 8).value, str) or not summary.cell(row, 8).value.startswith("=SUMIFS(") for row in range(2, summary.max_row + 1)):
        raise SystemExit("workbook annual summary lacks required detail-derived SUMIFS formulas")
    error_tokens = {"#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A"}
    errors = sum(1 for sheet in workbook.worksheets for row in sheet.iter_rows() for cell in row if isinstance(cell.value, str) and any(token in cell.value for token in error_tokens))
    if errors:
        raise SystemExit(f"workbook contains {errors} formula error token(s)")
    return errors


def package(output_dir: Path, package_path: Path) -> None:
    with zipfile.ZipFile(package_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(PACKAGE_FILES):
            archive.write(output_dir / name, name)


def verify(args: argparse.Namespace) -> dict:
    output_dir, package_path = args.output_dir, args.package_path
    if not DB.is_file():
        raise SystemExit(f"approved source SQLite extract is missing: {DB}")
    missing = [name for name in PACKAGE_FILES if not (output_dir / name).is_file()]
    if missing:
        raise SystemExit(f"output directory lacks required package members: {sorted(missing)}")
    receipt = (output_dir / "query_receipt.sql").read_text(encoding="utf-8")
    if "COALESCE(rp.SquareFootage,h.SquareFootage)" not in receipt or "DealerQty dealer_qty" not in receipt or "DealerQty *" in receipt:
        raise SystemExit("receipt fails the approved RO native-measure/reportability contract")
    connection = open_source()
    try:
        source = replay(connection)
        source_candidates, materials = independent_candidates(connection)
    finally:
        connection.close()
    ro_controls = {key: source["RO"][key] for key in EXPECTED_RO}
    if ro_controls != EXPECTED_RO:
        raise SystemExit(f"RO benchmark mismatch: {ro_controls} != {EXPECTED_RO}")
    annual = read_csv(output_dir / "annual_parent_year_color_lane.csv")
    expected_annual = {key: total for lane in source.values() for key, total in lane["aggregates"].items()}
    actual_annual: dict[tuple, Decimal] = {}
    for row in annual:
        key = (row["year"], row["lane"], nullable_int(row["parent_company_id"]), row["parent_company_name"], int(row["material_product_id"]), row["material_color"])
        if key in actual_annual:
            raise SystemExit(f"duplicate annual parent key: {key}")
        actual_annual[key] = decimal(row["calculated_measure"])
    if actual_annual != expected_annual:
        raise SystemExit(f"annual source replay mismatch (missing={len(set(expected_annual)-set(actual_annual))}, extra={len(set(actual_annual)-set(expected_annual))})")
    coverage = read_csv(output_dir / "coverage.csv")
    indexed_coverage = {(row["lane"], row["coverage_scope"], row["exclusion_reason"]): row for row in coverage}
    for scope, count_key, total_key in (("Cohort", "cohort_count", "cohort_total"), ("Reportable", "reportable_count", "reportable_total"), ("Excluded", "excluded_count", "excluded_total")):
        row = indexed_coverage.get(("RO", scope, "All cohort" if scope == "Cohort" else "All reportable" if scope == "Reportable" else "Non-positive DealerQty or reportability SquareFootage"))
        if row is None or int(row["source_line_count"]) != EXPECTED_RO[count_key] or decimal(row["calculated_measure"]) != EXPECTED_RO[total_key]:
            raise SystemExit(f"coverage does not reconcile RO {scope.lower()} control")
    lineage = read_csv(output_dir / "parent_company_lineage.csv")
    if not lineage or any(row["parent_is_source_company"] not in ("True", "False") for row in lineage):
        raise SystemExit("parent lineage rows lack the fallback/identity flag")
    crossover = read_csv(output_dir / "retail_catalog_color_crossover.csv")
    emitted_candidates = sorted((int(row["material_product_id"]), int(row["retail_product_id"]), int(row["retail_catalog_id"]), row["exact_consumer_description"]) for row in crossover if int(row["candidate_count"]) > 0)
    if emitted_candidates != source_candidates:
        raise SystemExit("lossless retail candidate relation differs from independent source replay")
    counts = Counter(material for material, *_ in source_candidates)
    for row in crossover:
        count = int(row["candidate_count"])
        expected_status = "Unmatched" if count == 0 else "Matched" if count == 1 else "Ambiguous"
        if row["mapping_status"] != expected_status or (count == 0 and (row["retail_product_id"] or row["exact_consumer_description"])):
            raise SystemExit("crossover cardinality/status contract failed")
    unmatched_materials = {int(row["material_product_id"]) for row in crossover if int(row["candidate_count"]) == 0}
    if unmatched_materials != materials - set(counts):
        raise SystemExit("crossover unmatched material sentinel relation differs from source")
    manufacturer = read_csv(output_dir / "house_po_sku_manufacturer.csv")
    if any(row["mapping_status"] not in {"Null MFRID", "Orphan MFRID", "Matched", "Multiple COM_Company matches"} for row in manufacturer):
        raise SystemExit("manufacturer mapping status is outside the approved contract")
    errors = validate_workbook(output_dir / "Sage_Quartz_Corrected_Parent_Color_Lane.xlsx", annual)
    validation = {
        "status": "independent verifier passed", "source_path": str(DB.relative_to(ROOT)), "source_sha256": hashlib.sha256(DB.read_bytes()).hexdigest(), "window": f"[{START}, {END})",
        "ro_controls": {key: str(value) for key, value in ro_controls.items()},
        "lane_replay": {lane: {"source_cohort_line_count": data["cohort_count"], "source_reportable_line_count": data["reportable_count"], "source_reportable_total": str(data["reportable_total"]), "generated_annual_total": str(sum(data["aggregates"].values(), Decimal(0))), "difference": str(data["reportable_total"] - sum(data["aggregates"].values(), Decimal(0)))} for lane, data in source.items()},
        "parent_rollup_rows": len(annual), "parent_lineage_rows": len(lineage), "crossover_source_candidates": len(source_candidates), "crossover_emitted_candidates": len(emitted_candidates), "crossover_status_counts": dict(Counter(row["mapping_status"] for row in crossover)), "manufacturer_status_counts": dict(Counter(row["mapping_status"] for row in manufacturer)), "workbook_formula_error_tokens": errors,
        "artifact_sha256": {name: hashlib.sha256((output_dir / name).read_bytes()).hexdigest() for name in PACKAGE_FILES if name != "validation.json"},
        "package_member_names": sorted(PACKAGE_FILES), "verification_command": "python3 scripts/verify_sag8351_sqft_account_two_colors.py --output-dir artifacts/2026-08-07/sag-8742 --package-path artifacts/SAG-8742_quartz_analysis_corrected_deliverable.zip",
    }
    (output_dir / "validation.json").write_text(json.dumps(validation, indent=2) + "\n", encoding="utf-8")
    package(output_dir, package_path)
    with zipfile.ZipFile(package_path) as archive:
        if set(archive.namelist()) != PACKAGE_FILES or archive.testzip() is not None:
            raise SystemExit("corrected ZIP membership or CRC check failed")
    validation["package_sha256"] = hashlib.sha256(package_path.read_bytes()).hexdigest()
    print(json.dumps(validation, sort_keys=True))
    return validation


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, default=ROOT / "artifacts/2026-08-07/sag-8742")
    parser.add_argument("--package-path", type=Path, default=ROOT / "artifacts/SAG-8742_quartz_analysis_corrected_deliverable.zip")
    verify(parser.parse_args())


if __name__ == "__main__":
    main()
