"""Year-based risk flag evaluation service."""

from __future__ import annotations

import logging
from typing import Any

from app.config import settings

logger = logging.getLogger(__name__)

# Configurable thresholds: (max_year, flag_type, severity, detail)
# Properties built BEFORE the threshold year trigger the flag.
RISK_YEAR_THRESHOLDS: list[dict[str, Any]] = [
    {
        "max_year": 1965,
        "flag_type": "knob_and_tube_wiring",
        "severity": "high",
        "detail": "Property built before 1965 — risk of knob-and-tube wiring. "
        "May require full rewire before insurable.",
    },
    {
        "max_year": 1978,
        "flag_type": "lead_paint",
        "severity": "high",
        "detail": "Property built before 1978 — federal lead paint disclosure required. "
        "Expect abatement or encapsulation costs.",
    },
    {
        "max_year": 1985,
        "flag_type": "asbestos",
        "severity": "high",
        "detail": "Property built before 1985 — asbestos risk in insulation, tiles, "
        "or popcorn ceilings. Professional abatement may be needed.",
    },
    {
        "max_year": 1994,
        "flag_type": "polybutylene_plumbing",
        "severity": "medium",
        "detail": "Property built before 1994 — risk of polybutylene plumbing. "
        "Known for premature failure; re-pipe may be required.",
    },
    {
        "max_year": 2000,
        "flag_type": "cast_iron_drains",
        "severity": "medium",
        "detail": "Property built before 2000 — cast iron drain lines may be corroded. "
        "Scope camera inspection during due diligence.",
    },
]


def evaluate_year_flags(year_built: int | None) -> list[dict[str, Any]]:
    """Evaluate year-based risk flags for a property.

    Returns a list of risk flag dicts ready for persistence.
    If year_built is None, returns a single unknown-year advisory flag.
    """
    if year_built is None:
        return [
            {
                "flag_type": "unknown_year",
                "severity": "low",
                "detail": "Construction year unknown — unable to evaluate "
                "age-related risk factors. Verify year_built.",
                "source": "year_built",
            }
        ]

    flags: list[dict[str, Any]] = []
    for threshold in RISK_YEAR_THRESHOLDS:
        if year_built < threshold["max_year"]:
            flags.append(
                {
                    "flag_type": threshold["flag_type"],
                    "severity": threshold["severity"],
                    "detail": threshold["detail"],
                    "source": "year_built",
                }
            )

    return flags
