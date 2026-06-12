"""Lendability composite score calculator."""

from __future__ import annotations

from decimal import Decimal
from typing import Any


def calculate_lendability(
    property_data: dict[str, Any],
    risk_flags: list[dict[str, Any]],
    arv_calculations: list[dict[str, Any]],
) -> dict[str, Any]:
    """Calculate a lendability composite score (0–100).

    Weights:
        Year-based risk flags:  30%
        Flood zone risk:        25%
        Property condition:     20%
        ARV-to-purchase ratio:  25%

    Categories:
        Green:  70–100
        Yellow: 40–69
        Red:    0–39

    Handles missing data gracefully with neutral defaults.
    """
    year_score = _score_year_flags(risk_flags)
    flood_score = _score_flood_risk(risk_flags)
    condition_score = _score_condition(property_data)
    arv_score = _score_arv_ratio(property_data, arv_calculations)

    total = year_score + flood_score + condition_score + arv_score

    if total >= 70:
        category = "green"
    elif total >= 40:
        category = "yellow"
    else:
        category = "red"

    return {
        "score": total,
        "category": category,
        "breakdown": {
            "year_risk": year_score,
            "flood_risk": flood_score,
            "condition": condition_score,
            "arv_ratio": arv_score,
        },
    }


def _score_year_flags(risk_flags: list[dict[str, Any]]) -> int:
    """Score year-based risks (max 30 points).

    Start at 30 and deduct per year-related flag by severity.
    """
    score = 30
    severity_penalties = {"high": 10, "medium": 5, "low": 2}

    for flag in risk_flags:
        if flag.get("source") == "year_built":
            severity = (flag.get("severity") or "low").lower()
            score -= severity_penalties.get(severity, 2)

    return max(score, 0)


def _score_flood_risk(risk_flags: list[dict[str, Any]]) -> int:
    """Score flood zone risk (max 25 points).

    25 = no flood risk, 15 = moderate, 5 = high-risk zone.
    """
    for flag in risk_flags:
        if flag.get("source") == "fema":
            severity = (flag.get("severity") or "low").lower()
            if severity == "high":
                return 5
            elif severity == "medium":
                return 15
            # low or info
            return 22

    # No FEMA data — neutral assumption
    return 20


def _score_condition(property_data: dict[str, Any]) -> int:
    """Score property condition (max 20 points).

    Uses available data signals; defaults to 15 (neutral) when unknown.
    """
    year_built = property_data.get("year_built")
    if year_built is None:
        return 15

    # Newer properties generally in better condition
    if year_built >= 2010:
        return 20
    elif year_built >= 2000:
        return 18
    elif year_built >= 1980:
        return 15
    elif year_built >= 1960:
        return 12
    else:
        return 8


def _score_arv_ratio(
    property_data: dict[str, Any],
    arv_calculations: list[dict[str, Any]],
) -> int:
    """Score ARV-to-purchase ratio (max 25 points).

    ratio >= 1.5 → 25, 1.3–1.5 → 20, 1.1–1.3 → 15, < 1.1 → 5.
    No data → neutral 15.
    """
    listing_price = property_data.get("listing_price")
    if listing_price is not None:
        listing_price = float(listing_price) if isinstance(listing_price, Decimal) else listing_price

    if not listing_price or listing_price <= 0:
        return 15

    # Use most recent ARV calculation
    arv_mid: float | None = None
    if arv_calculations:
        latest = arv_calculations[0]
        arv_mid_raw = latest.get("arv_mid")
        if arv_mid_raw is not None:
            arv_mid = float(arv_mid_raw) if isinstance(arv_mid_raw, Decimal) else arv_mid_raw

    if arv_mid is None or arv_mid <= 0:
        return 15

    ratio = arv_mid / listing_price

    if ratio >= 1.5:
        return 25
    elif ratio >= 1.3:
        return 20
    elif ratio >= 1.1:
        return 15
    else:
        return 5
