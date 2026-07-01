"""Quote builder service — AI generation, totals calculation, and PDF SOW."""

from __future__ import annotations

import io
import logging
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from app.config import settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PLATFORM_FEE_DEFAULT = Decimal("0.05")  # 5%

# Labor cost estimates per trade category ($/hr baseline)
TRADE_LABOR_RATES: dict[str, int] = {
    "plumbing": 95,
    "electrical": 90,
    "flooring": 70,
    "painting": 55,
    "roofing": 85,
    "hvac": 100,
    "general": 60,
    "carpentry": 75,
    "drywall": 65,
    "demolition": 50,
    "tile": 75,
    "cabinets": 80,
    "countertops": 70,
    "windows": 85,
    "insulation": 60,
}

# Map renovation_needed → estimated hours per room
RENOVATION_HOURS: dict[str, float] = {
    "none": 0,
    "cosmetic": 4,
    "moderate": 16,
    "major": 40,
    "full_gut": 80,
}

# Map room_type + condition → suggested trade categories
ROOM_TRADE_MAP: dict[str, list[str]] = {
    "kitchen": ["cabinets", "countertops", "plumbing", "electrical", "flooring", "painting"],
    "bathroom": ["plumbing", "tile", "painting", "electrical"],
    "bedroom": ["painting", "flooring", "electrical"],
    "living_room": ["painting", "flooring", "electrical"],
    "basement": ["general", "drywall", "flooring", "plumbing", "electrical"],
    "exterior": ["roofing", "painting", "windows", "insulation"],
    "garage": ["general", "electrical"],
    "attic": ["insulation", "drywall", "electrical"],
    "hallway": ["painting", "flooring"],
    "dining_room": ["painting", "flooring"],
    "laundry": ["plumbing", "electrical", "flooring"],
    "yard": ["general"],
    "roof": ["roofing"],
    "other": ["general"],
}


# ---------------------------------------------------------------------------
# Totals calculation
# ---------------------------------------------------------------------------


def calculate_item_subtotal(
    quantity: int,
    unit_cost: Decimal,
    labor_cost: Decimal,
    markup_pct: Decimal | None,
) -> Decimal:
    """Calculate line item subtotal: (quantity * unit_cost + labor_cost) * (1 + markup)."""
    material = Decimal(quantity) * unit_cost
    markup = Decimal("1") + (markup_pct or Decimal("0")) / Decimal("100")
    return (material + labor_cost) * markup


def calculate_quote_totals(
    items: list[dict[str, Any]],
    platform_fee_pct: Decimal | None = None,
) -> dict[str, Decimal]:
    """Compute totals from a list of item dicts.

    Returns dict with total_material, total_labor, platform_fee, grand_total.
    """
    total_material = Decimal("0")
    total_labor = Decimal("0")

    for item in items:
        qty = item.get("quantity", 1) or 1
        uc = Decimal(str(item.get("unit_cost", 0) or 0))
        lc = Decimal(str(item.get("labor_cost", 0) or 0))
        markup = Decimal(str(item.get("markup_pct", 0) or 0))
        markup_mult = Decimal("1") + markup / Decimal("100")

        total_material += Decimal(qty) * uc * markup_mult
        total_labor += lc * markup_mult

    subtotal = total_material + total_labor
    fee_pct = platform_fee_pct if platform_fee_pct is not None else PLATFORM_FEE_DEFAULT
    platform_fee = subtotal * fee_pct
    grand_total = subtotal + platform_fee

    return {
        "total_material": total_material.quantize(Decimal("0.01")),
        "total_labor": total_labor.quantize(Decimal("0.01")),
        "platform_fee": platform_fee.quantize(Decimal("0.01")),
        "grand_total": grand_total.quantize(Decimal("0.01")),
    }


# ---------------------------------------------------------------------------
# AI quote generation
# ---------------------------------------------------------------------------


def generate_ai_line_items(
    labels: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Generate quote line items from photo analysis labels.

    Each label represents a room photo with room_type, condition,
    damage_issues, renovation_needed, and confidence.
    """
    items: list[dict[str, Any]] = []
    seen_rooms: dict[str, int] = {}

    for label in labels:
        room_type = label.get("room_type") or "other"
        renovation = label.get("renovation_needed") or "none"
        condition = label.get("condition") or "fair"
        confidence = label.get("confidence", 0.5)
        damage_issues = label.get("damage_issues") or []

        if renovation == "none":
            continue

        # Track room count for numbering
        seen_rooms[room_type] = seen_rooms.get(room_type, 0) + 1
        room_label = (
            f"{room_type.replace('_', ' ').title()} {seen_rooms[room_type]}"
            if seen_rooms[room_type] > 1
            else room_type.replace("_", " ").title()
        )

        trades = ROOM_TRADE_MAP.get(room_type, ["general"])
        hours = RENOVATION_HOURS.get(renovation, 8)

        # Generate one item per relevant trade
        for trade in trades:
            rate = TRADE_LABOR_RATES.get(trade, 60)
            labor_hours = hours / len(trades)
            labor_cost = Decimal(str(round(rate * labor_hours, 2)))

            # Estimate material cost based on renovation level
            material_mult = {"cosmetic": 0.3, "moderate": 0.6, "major": 1.0, "full_gut": 1.5}
            unit_cost = Decimal(str(round(rate * material_mult.get(renovation, 0.5) * 2, 2)))

            desc_parts = [f"{trade.title()} — {renovation} renovation"]
            if damage_issues:
                desc_parts.append(f"Issues: {', '.join(damage_issues[:3])}")

            items.append({
                "room": room_label,
                "trade_category": trade,
                "description": "; ".join(desc_parts),
                "sage_sku": None,
                "quantity": 1,
                "unit_cost": unit_cost,
                "labor_cost": labor_cost,
                "markup_pct": None,
                "unit_of_measure": "job",
                "ai_confidence": round(confidence, 3),
                "is_ai_generated": True,
            })

    return items


# ---------------------------------------------------------------------------
# PDF SOW generation
# ---------------------------------------------------------------------------


def generate_sow_pdf(
    quote: dict[str, Any],
    items: list[dict[str, Any]],
    property_info: dict[str, Any] | None = None,
) -> bytes:
    """Generate a professional PDF Scope of Work from quote data.

    Returns the PDF bytes.
    """
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=letter,
        leftMargin=0.75 * inch,
        rightMargin=0.75 * inch,
        topMargin=0.75 * inch,
        bottomMargin=0.75 * inch,
    )

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "SOWTitle",
        parent=styles["Title"],
        fontSize=20,
        spaceAfter=12,
        textColor=colors.HexColor("#1a365d"),
    )
    heading_style = ParagraphStyle(
        "SOWHeading",
        parent=styles["Heading2"],
        fontSize=14,
        spaceBefore=16,
        spaceAfter=8,
        textColor=colors.HexColor("#2d3748"),
    )
    body_style = styles["Normal"]
    body_style.fontSize = 10
    body_style.leading = 14

    elements: list[Any] = []

    # Title
    elements.append(Paragraph("Scope of Work", title_style))
    elements.append(Spacer(1, 4))

    # Property details
    if property_info:
        elements.append(Paragraph("Property Details", heading_style))
        addr = property_info.get("address", "N/A")
        city = property_info.get("city", "")
        state = property_info.get("state", "")
        zip_code = property_info.get("zip", "")
        full_addr = f"{addr}, {city}, {state} {zip_code}".strip(", ")
        details = [
            f"<b>Address:</b> {full_addr}",
            f"<b>Property Type:</b> {property_info.get('property_type', 'N/A')}",
            f"<b>Sq Ft:</b> {property_info.get('sqft', 'N/A')}",
            f"<b>Beds/Baths:</b> {property_info.get('beds', 'N/A')} / {property_info.get('baths', 'N/A')}",
        ]
        for d in details:
            elements.append(Paragraph(d, body_style))
        elements.append(Spacer(1, 8))

    # Quote metadata
    elements.append(Paragraph("Quote Information", heading_style))
    quote_date = quote.get("created_at", "")
    if isinstance(quote_date, datetime):
        quote_date = quote_date.strftime("%B %d, %Y")
    elements.append(Paragraph(f"<b>Quote ID:</b> {quote.get('id', 'N/A')}", body_style))
    elements.append(Paragraph(f"<b>Date:</b> {quote_date}", body_style))
    elements.append(Paragraph(f"<b>Status:</b> {quote.get('status', 'draft').title()}", body_style))
    if quote.get("notes"):
        elements.append(Paragraph(f"<b>Notes:</b> {quote['notes']}", body_style))
    elements.append(Spacer(1, 12))

    # Line items table
    elements.append(Paragraph("Line Items", heading_style))

    table_data = [["Room", "Trade", "Description", "Qty", "Unit Cost", "Labor", "Subtotal"]]
    for item in items:
        qty = item.get("quantity", 1) or 1
        uc = Decimal(str(item.get("unit_cost", 0) or 0))
        lc = Decimal(str(item.get("labor_cost", 0) or 0))
        markup = Decimal(str(item.get("markup_pct", 0) or 0))
        sub = calculate_item_subtotal(qty, uc, lc, markup if markup else None)

        desc = item.get("description", "") or ""
        if len(desc) > 50:
            desc = desc[:47] + "..."

        table_data.append([
            item.get("room", "") or "",
            item.get("trade_category", "") or "",
            desc,
            str(qty),
            f"${uc:,.2f}",
            f"${lc:,.2f}",
            f"${sub:,.2f}",
        ])

    col_widths = [1.0 * inch, 0.9 * inch, 2.0 * inch, 0.5 * inch, 0.8 * inch, 0.8 * inch, 0.9 * inch]
    t = Table(table_data, colWidths=col_widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#2d3748")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTSIZE", (0, 0), (-1, 0), 9),
        ("FONTSIZE", (0, 1), (-1, -1), 8),
        ("ALIGN", (3, 0), (-1, -1), "RIGHT"),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e0")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f7fafc")]),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    elements.append(t)
    elements.append(Spacer(1, 16))

    # Totals
    elements.append(Paragraph("Summary", heading_style))
    total_material = quote.get("total_material") or Decimal("0")
    total_labor = quote.get("total_labor") or Decimal("0")
    platform_fee = quote.get("platform_fee") or Decimal("0")
    fee_pct = quote.get("platform_fee_pct") or PLATFORM_FEE_DEFAULT
    grand_total = quote.get("grand_total") or Decimal("0")

    summary_data = [
        ["Materials", f"${Decimal(str(total_material)):,.2f}"],
        ["Labor", f"${Decimal(str(total_labor)):,.2f}"],
        [f"Platform Fee ({Decimal(str(fee_pct)) * 100:.1f}%)", f"${Decimal(str(platform_fee)):,.2f}"],
        ["Grand Total", f"${Decimal(str(grand_total)):,.2f}"],
    ]
    summary_table = Table(summary_data, colWidths=[4.0 * inch, 1.5 * inch])
    summary_table.setStyle(TableStyle([
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("LINEABOVE", (0, -1), (-1, -1), 1.5, colors.HexColor("#2d3748")),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    elements.append(summary_table)
    elements.append(Spacer(1, 24))

    # Footer
    elements.append(Paragraph(
        "<i>This Scope of Work was generated by the GCP Renovation Platform. "
        "All pricing is estimated and subject to final site inspection.</i>",
        ParagraphStyle("Footer", parent=body_style, fontSize=8, textColor=colors.grey),
    ))

    doc.build(elements)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# S3 upload helper
# ---------------------------------------------------------------------------


async def upload_sow_to_s3(pdf_bytes: bytes, quote_id: str) -> str:
    """Upload SOW PDF to S3 and return the key."""
    import boto3

    s3_key = f"sow/{quote_id}/{uuid.uuid4().hex}.pdf"

    s3 = boto3.client(
        "s3",
        aws_access_key_id=settings.AWS_ACCESS_KEY,
        aws_secret_access_key=settings.AWS_SECRET_KEY,
    )
    s3.put_object(
        Bucket=settings.S3_BUCKET,
        Key=s3_key,
        Body=pdf_bytes,
        ContentType="application/pdf",
    )

    return s3_key


async def download_sow_from_s3(s3_key: str) -> bytes:
    """Download SOW PDF bytes from S3."""
    import boto3

    s3 = boto3.client(
        "s3",
        aws_access_key_id=settings.AWS_ACCESS_KEY,
        aws_secret_access_key=settings.AWS_SECRET_KEY,
    )
    resp = s3.get_object(Bucket=settings.S3_BUCKET, Key=s3_key)
    return resp["Body"].read()
