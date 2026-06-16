"""Credit-memo cause-code reporting view (SAG-2806).

Endpoints:
  GET /credit-memos/report        — segmented daily/weekly JSON report
  GET /credit-memos/report/export — CSV download matching JSON totals

Segmentation dimensions: cause_code, territory_id, rsm_id, product_tier, qc_stage.
Cross-tab via optional ?dim2=<dimension>.

Aggregation is done in Python (not SQL) for SQLite/PostgreSQL portability. Data
volumes for credit memos are small (<10 k rows/month), so this is acceptable.
"""

from __future__ import annotations

import csv
import io
from collections import defaultdict
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import CurrentUser, get_current_user
from app.database import get_db
from app.models import CreditMemo
from app.schemas.credit_memo_report import (
    ReportGranularity,
    ReportResponse,
    ReportRow,
    ReportSegment,
)

router = APIRouter(prefix="/credit-memos", tags=["credit-memos"])

# Map enum value → model attribute name (they are identical, but explicit is safer)
_SEGMENT_ATTR: dict[str, str] = {
    "cause_code": "cause_code",
    "territory_id": "territory_id",
    "rsm_id": "rsm_id",
    "product_tier": "product_tier",
    "qc_stage": "qc_stage",
}


def _period_key(dt: datetime, granularity: ReportGranularity) -> str:
    """Return a sortable string period key for a datetime."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    d = dt.date()
    if granularity == ReportGranularity.daily:
        return d.isoformat()
    # ISO week: Monday as week start, e.g. "2024-W03"
    iso = d.isocalendar()
    return f"{iso.year}-W{iso.week:02d}"


def _aggregate(
    memos: list[CreditMemo],
    granularity: ReportGranularity,
    segment_by: ReportSegment,
    dim2: ReportSegment | None,
) -> list[ReportRow]:
    """Group memos into report rows. O(n) over memo list."""
    # key: (period, seg_value, dim2_value)
    buckets: dict[tuple[str, str | None, str | None], dict[str, Any]] = defaultdict(
        lambda: {"credit_amount_total": Decimal("0"), "memo_count": 0}
    )

    seg_attr = _SEGMENT_ATTR[segment_by.value]
    dim2_attr = _SEGMENT_ATTR[dim2.value] if dim2 else None

    for memo in memos:
        period = _period_key(memo.created_at, granularity)
        seg_val: str | None = getattr(memo, seg_attr)
        d2_val: str | None = getattr(memo, dim2_attr) if dim2_attr else None
        key = (period, seg_val, d2_val)
        bucket = buckets[key]
        bucket["credit_amount_total"] += memo.amount if memo.amount is not None else Decimal("0")
        bucket["memo_count"] += 1

    rows = [
        ReportRow(
            period=period,
            segment_value=seg_val,
            dim2_value=d2_val,
            credit_amount_total=v["credit_amount_total"],
            memo_count=v["memo_count"],
        )
        for (period, seg_val, d2_val), v in sorted(buckets.items())
    ]
    return rows


async def _fetch_memos(
    db: AsyncSession,
    tenant_id: str,
    start_date: date,
    end_date: date,
) -> list[CreditMemo]:
    start_dt = datetime(start_date.year, start_date.month, start_date.day, tzinfo=timezone.utc)
    # End date is inclusive — extend to end-of-day
    end_dt = datetime(end_date.year, end_date.month, end_date.day, 23, 59, 59, tzinfo=timezone.utc)

    result = await db.execute(
        select(CreditMemo)
        .where(
            CreditMemo.tenant_id == tenant_id,
            CreditMemo.created_at >= start_dt,
            CreditMemo.created_at <= end_dt,
        )
        .order_by(CreditMemo.created_at)
    )
    return list(result.scalars().all())


# ---------------------------------------------------------------------------
# GET /credit-memos/report
# ---------------------------------------------------------------------------


@router.get("/report", response_model=ReportResponse)
async def credit_memo_report(
    start_date: date = Query(..., description="Start date (inclusive), YYYY-MM-DD"),
    end_date: date = Query(..., description="End date (inclusive), YYYY-MM-DD"),
    segment_by: ReportSegment = Query(..., description="Primary segmentation dimension"),
    granularity: ReportGranularity = Query(ReportGranularity.daily, description="daily or weekly"),
    dim2: ReportSegment | None = Query(None, description="Optional second dimension for cross-tab"),
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ReportResponse:
    """Return credit $ + count segmented by dimension, for a date range, at daily or weekly granularity."""
    if end_date < start_date:
        raise HTTPException(status_code=422, detail="end_date must be >= start_date")

    tenant_id = current_user.effective_tenant_id
    memos = await _fetch_memos(db, tenant_id, start_date, end_date)
    rows = _aggregate(memos, granularity, segment_by, dim2)

    total_amount = sum((r.credit_amount_total for r in rows), Decimal("0"))
    total_count = sum(r.memo_count for r in rows)

    return ReportResponse(
        granularity=granularity,
        segment_by=segment_by,
        dim2=dim2,
        start_date=start_date.isoformat(),
        end_date=end_date.isoformat(),
        rows=rows,
        total_credit_amount=total_amount,
        total_memo_count=total_count,
    )


# ---------------------------------------------------------------------------
# GET /credit-memos/report/export  (CSV)
# ---------------------------------------------------------------------------


@router.get("/report/export")
async def credit_memo_report_export(
    start_date: date = Query(..., description="Start date (inclusive), YYYY-MM-DD"),
    end_date: date = Query(..., description="End date (inclusive), YYYY-MM-DD"),
    segment_by: ReportSegment = Query(..., description="Primary segmentation dimension"),
    granularity: ReportGranularity = Query(ReportGranularity.daily),
    dim2: ReportSegment | None = Query(None),
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """Download credit-memo report as CSV. Columns match JSON /report rows."""
    if end_date < start_date:
        raise HTTPException(status_code=422, detail="end_date must be >= start_date")

    tenant_id = current_user.effective_tenant_id
    memos = await _fetch_memos(db, tenant_id, start_date, end_date)
    rows = _aggregate(memos, granularity, segment_by, dim2)

    buf = io.StringIO()
    fieldnames = ["period", "segment_value", "credit_amount_total", "memo_count"]
    if dim2:
        fieldnames.insert(2, "dim2_value")

    writer = csv.DictWriter(buf, fieldnames=fieldnames)
    writer.writeheader()
    for row in rows:
        record: dict[str, Any] = {
            "period": row.period,
            "segment_value": row.segment_value if row.segment_value is not None else "",
            "credit_amount_total": str(row.credit_amount_total),
            "memo_count": row.memo_count,
        }
        if dim2:
            record["dim2_value"] = row.dim2_value if row.dim2_value is not None else ""
        writer.writerow(record)

    filename = f"credit_memo_report_{start_date}_{end_date}_{segment_by.value}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
