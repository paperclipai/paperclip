#!/usr/bin/env python3
"""
견적 xlsx 하단 합계/부가세/총계를 숫자로 고정한다.

Numbers PDF export에서 수식 셀이 비어 나가는 문제를 피하기 위한 보정 스크립트다.
"""

from __future__ import annotations

import argparse
import pathlib
from decimal import Decimal, ROUND_DOWN

from openpyxl import load_workbook


DEFAULT_SHEET = "개발견적서"
DEFAULT_SUPPLY_RANGE = "K11:M35"
DEFAULT_SUMMARY_CELLS = ("F37", "F38", "F39")
KRW_FORMAT = '"₩"#,##0'


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="견적 xlsx 하단 합계 영역 숫자 확정")
    parser.add_argument("xlsx_path", help="대상 xlsx 파일 경로")
    parser.add_argument("--sheet", default=DEFAULT_SHEET, help="시트 이름")
    parser.add_argument(
        "--supply-range",
        default=DEFAULT_SUPPLY_RANGE,
        help="공급가 계산에 사용할 셀 범위",
    )
    parser.add_argument(
        "--vat-rate",
        default="0.1",
        help="부가세율. 기본값 0.1",
    )
    return parser.parse_args()


def sum_numeric_cells(worksheet, cell_range: str) -> int:
    total = Decimal("0")
    for row in worksheet[cell_range]:
        for cell in row:
            if isinstance(cell.value, (int, float)):
                total += Decimal(str(cell.value))
    return int(total)


def finalize_quote(path: pathlib.Path, sheet_name: str, supply_range: str, vat_rate: Decimal) -> tuple[int, int, int]:
    workbook = load_workbook(path)
    worksheet = workbook[sheet_name]

    supply = sum_numeric_cells(worksheet, supply_range)
    vat = int((Decimal(supply) * vat_rate).quantize(Decimal("1"), rounding=ROUND_DOWN))
    total = supply + vat

    values = {
        DEFAULT_SUMMARY_CELLS[0]: supply,
        DEFAULT_SUMMARY_CELLS[1]: vat,
        DEFAULT_SUMMARY_CELLS[2]: total,
    }
    for cell_name, value in values.items():
        worksheet[cell_name] = value
        worksheet[cell_name].number_format = KRW_FORMAT

    workbook.save(path)
    return supply, vat, total


def main() -> None:
    args = parse_args()
    path = pathlib.Path(args.xlsx_path).expanduser().resolve()
    supply, vat, total = finalize_quote(
        path=path,
        sheet_name=args.sheet,
        supply_range=args.supply_range,
        vat_rate=Decimal(args.vat_rate),
    )
    print(f"xlsx: {path}")
    print(f"supply: {supply}")
    print(f"vat: {vat}")
    print(f"total: {total}")


if __name__ == "__main__":
    main()
