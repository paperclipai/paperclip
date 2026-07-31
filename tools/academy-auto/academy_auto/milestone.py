from __future__ import annotations

from .pending import PendingRecord


def is_milestone(rec: PendingRecord, delta_threshold: int) -> bool:
    """Milestone, wenn ein Change bereitliegt ODER ein Fehler auftrat ODER
    das Gate-Delta die Schwelle erreicht (grosser Test)."""
    if rec.has_change:
        return True
    if rec.outcome == "error":
        return True
    return abs(rec.tsc_delta) >= delta_threshold
