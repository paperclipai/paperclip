"""ARV (After Repair Value) range calculator.

Always returns a confidence band (low / mid / high), never a point estimate.
Weights comps by distance, recency, and similarity score.
Minimum 3 comps required for a valid ARV calculation.
"""

from __future__ import annotations

import logging
import statistics
from datetime import date
from typing import Any

logger = logging.getLogger(__name__)

MIN_COMPS_REQUIRED = 3


class InsufficientCompsError(Exception):
    """Raised when fewer than MIN_COMPS_REQUIRED comps are available."""

    def __init__(self, available: int) -> None:
        self.available = available
        super().__init__(
            f"Insufficient comps for ARV calculation: {available} available, "
            f"{MIN_COMPS_REQUIRED} required"
        )


def _weight_for_comp(comp: dict[str, Any]) -> float:
    """Compute a weight for a single comp based on distance, recency, similarity.

    Higher weight = more influence on the ARV estimate.
    """
    similarity = comp.get("similarity", 0.5)
    distance = comp.get("distance")
    sale_date = comp.get("sale_date")

    # Distance weight: closer = higher weight (inverse, capped)
    if distance is not None and distance > 0:
        dist_weight = 1.0 / (1.0 + distance)
    else:
        dist_weight = 1.0

    # Recency weight: more recent = higher weight
    if isinstance(sale_date, date):
        days_old = (date.today() - sale_date).days
        recency_weight = max(0.1, 1.0 - days_old / 365.0)
    else:
        recency_weight = 0.5

    # Combine: similarity already captures attribute match
    return similarity * dist_weight * recency_weight


def calculate_arv(
    comps: list[dict[str, Any]],
    subject: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Calculate ARV range from a list of sold comps.

    Returns:
        dict with arv_low, arv_mid, arv_high, confidence, comp_count, methodology
    Raises:
        InsufficientCompsError if fewer than 3 comps with sale prices.
    """
    # Filter to comps that have sale prices
    priced = [c for c in comps if c.get("sale_price") and float(c["sale_price"]) > 0]

    if len(priced) < MIN_COMPS_REQUIRED:
        raise InsufficientCompsError(len(priced))

    # Compute weighted average and gather price-per-sqft data
    weights: list[float] = []
    prices: list[float] = []
    price_per_sqft_vals: list[float] = []

    for comp in priced:
        w = _weight_for_comp(comp)
        p = float(comp["sale_price"])
        weights.append(w)
        prices.append(p)

        c_sqft = comp.get("sqft")
        if c_sqft and c_sqft > 0:
            price_per_sqft_vals.append(p / c_sqft)

    # Weighted average price
    total_weight = sum(weights)
    if total_weight == 0:
        total_weight = 1.0
    weighted_avg = sum(p * w for p, w in zip(prices, weights)) / total_weight

    # If we have price/sqft data and subject sqft, use $/sqft method too
    sqft_adjusted_avg: float | None = None
    subject_sqft = (subject or {}).get("sqft")
    if price_per_sqft_vals and subject_sqft and subject_sqft > 0:
        weighted_ppsf = sum(
            ppsf * w for ppsf, w in zip(price_per_sqft_vals, weights[: len(price_per_sqft_vals)])
        ) / sum(weights[: len(price_per_sqft_vals)])
        sqft_adjusted_avg = weighted_ppsf * subject_sqft

    # Mid estimate: blend of weighted avg price and sqft-adjusted (if available)
    if sqft_adjusted_avg is not None:
        arv_mid = 0.6 * sqft_adjusted_avg + 0.4 * weighted_avg
    else:
        arv_mid = weighted_avg

    # Standard deviation for confidence band
    if len(prices) >= 3:
        stdev = statistics.stdev(prices)
        # Use coefficient of variation to scale the band
        cv = stdev / arv_mid if arv_mid > 0 else 0.15
        band_pct = max(0.05, min(0.20, cv))  # clamp between 5-20%
    else:
        band_pct = 0.10  # default 10% band

    arv_low = arv_mid * (1.0 - band_pct)
    arv_high = arv_mid * (1.0 + band_pct)

    # Confidence score (0-1): based on comp count, similarity, and price dispersion
    count_factor = min(1.0, len(priced) / 8.0)  # max confidence at 8+ comps
    avg_similarity = sum(c.get("similarity", 0.5) for c in priced) / len(priced)
    dispersion_factor = max(0.0, 1.0 - band_pct / 0.20)
    confidence = round(0.40 * count_factor + 0.35 * avg_similarity + 0.25 * dispersion_factor, 4)

    methodology = {
        "method": "weighted_comparable_sales",
        "comp_count": len(priced),
        "weighted_avg_price": round(weighted_avg, 2),
        "sqft_adjusted_avg": round(sqft_adjusted_avg, 2) if sqft_adjusted_avg else None,
        "blend_ratio": "60% sqft-adjusted / 40% weighted avg" if sqft_adjusted_avg else "100% weighted avg",
        "band_pct": round(band_pct, 4),
        "avg_similarity": round(avg_similarity, 4),
        "weights": {
            "distance": "inverse distance decay",
            "recency": "linear decay over 365 days",
            "similarity": "attribute-based (sqft, beds, baths, year)",
        },
    }

    return {
        "arv_low": round(arv_low, 2),
        "arv_mid": round(arv_mid, 2),
        "arv_high": round(arv_high, 2),
        "confidence": confidence,
        "comp_count": len(priced),
        "methodology": methodology,
    }
