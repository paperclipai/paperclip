"""Pydantic schemas for risk flag system endpoints."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel


# ---------------------------------------------------------------------------
# Response schemas
# ---------------------------------------------------------------------------


class RiskFlagResponse(BaseModel):
    """Single risk flag."""

    id: str
    property_id: str
    flag_type: str | None = None
    severity: str | None = None
    detail: str | None = None
    source: str | None = None

    model_config = {"from_attributes": True}


class RiskFlagListResponse(BaseModel):
    """List of risk flags for a property."""

    property_id: str
    flags: list[RiskFlagResponse]
    total: int


class LendabilityBreakdown(BaseModel):
    """Score breakdown by risk category."""

    year_risk: int
    flood_risk: int
    condition: int
    arv_ratio: int


class LendabilityScoreResponse(BaseModel):
    """Lendability composite score result."""

    score: int
    category: str
    breakdown: LendabilityBreakdown


class RiskEvaluationResponse(BaseModel):
    """Full risk evaluation result (flags + lendability score)."""

    property_id: str
    flags: list[RiskFlagResponse]
    lendability: LendabilityScoreResponse
