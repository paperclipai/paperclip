"""Pydantic schemas for financing engine endpoints."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Request schemas — individual models
# ---------------------------------------------------------------------------


class FixAndFlipRequest(BaseModel):
    purchase_price: float = Field(..., gt=0)
    rehab_cost: float = Field(..., ge=0)
    arv: float = Field(..., gt=0)
    hold_months: int = Field(6, ge=1, le=60)
    monthly_hold_cost: float = Field(0, ge=0)
    buying_closing_pct: float = Field(0.02, ge=0, le=0.10)
    selling_closing_pct: float = Field(0.06, ge=0, le=0.15)
    loan_amount: float = Field(0, ge=0)
    loan_rate: float = Field(0, ge=0, le=1.0)


class BRRRRRequest(BaseModel):
    purchase_price: float = Field(..., gt=0)
    rehab_cost: float = Field(..., ge=0)
    arv: float = Field(..., gt=0)
    monthly_rent: float = Field(..., gt=0)
    hold_months_before_refi: int = Field(6, ge=1, le=24)
    refi_ltv: float = Field(0.75, ge=0.1, le=1.0)
    refi_rate: float = Field(0.07, ge=0, le=0.20)
    refi_term_years: int = Field(30, ge=1, le=40)
    monthly_expenses: float = Field(0, ge=0)
    vacancy_rate: float = Field(0.08, ge=0, le=1.0)
    buying_closing_pct: float = Field(0.02, ge=0, le=0.10)
    initial_loan_amount: float = Field(0, ge=0)
    initial_loan_rate: float = Field(0, ge=0, le=1.0)


class BuyAndHoldRequest(BaseModel):
    purchase_price: float = Field(..., gt=0)
    monthly_rent: float = Field(..., gt=0)
    down_payment_pct: float = Field(0.20, ge=0, le=1.0)
    loan_rate: float = Field(0.07, ge=0, le=0.20)
    loan_term_years: int = Field(30, ge=1, le=40)
    monthly_expenses: float = Field(0, ge=0)
    vacancy_rate: float = Field(0.08, ge=0, le=1.0)
    annual_appreciation: float = Field(0.03, ge=-0.10, le=0.20)
    annual_rent_growth: float = Field(0.02, ge=-0.10, le=0.20)
    closing_costs_pct: float = Field(0.03, ge=0, le=0.10)


class ShortTermRentalRequest(BaseModel):
    purchase_price: float = Field(..., gt=0)
    nightly_rate: float = Field(..., gt=0)
    occupancy_rate: float = Field(0.70, ge=0, le=1.0)
    down_payment_pct: float = Field(0.20, ge=0, le=1.0)
    loan_rate: float = Field(0.07, ge=0, le=0.20)
    loan_term_years: int = Field(30, ge=1, le=40)
    monthly_expenses: float = Field(0, ge=0)
    platform_fee_pct: float = Field(0.03, ge=0, le=0.30)
    cleaning_fee_per_turn: float = Field(0, ge=0)
    avg_stay_nights: float = Field(3.0, ge=1, le=30)
    seasonal_adjustments: dict[str, float] | None = None
    closing_costs_pct: float = Field(0.03, ge=0, le=0.10)


class WholesaleRequest(BaseModel):
    arv: float = Field(..., gt=0)
    rehab_cost: float = Field(..., ge=0)
    assignment_fee: float = Field(10_000, ge=0)
    buyer_profit_margin: float = Field(0.30, ge=0.05, le=0.60)
    closing_costs_pct: float = Field(0.01, ge=0, le=0.10)
    earnest_money: float = Field(1_000, ge=0)


class SubjectToRequest(BaseModel):
    property_value: float = Field(..., gt=0)
    existing_mortgage_balance: float = Field(..., ge=0)
    existing_mortgage_rate: float = Field(..., ge=0, le=0.20)
    existing_mortgage_remaining_months: int = Field(..., ge=1, le=480)
    monthly_rent: float = Field(..., gt=0)
    cash_to_seller: float = Field(0, ge=0)
    monthly_expenses: float = Field(0, ge=0)
    vacancy_rate: float = Field(0.08, ge=0, le=1.0)
    closing_costs: float = Field(0, ge=0)
    wrap_rate: float | None = Field(None, ge=0, le=0.20)
    wrap_term_months: int | None = Field(None, ge=1, le=480)


class SellerFinancingRequest(BaseModel):
    purchase_price: float = Field(..., gt=0)
    monthly_rent: float = Field(..., gt=0)
    down_payment_pct: float = Field(0.10, ge=0, le=1.0)
    seller_rate: float = Field(0.06, ge=0, le=0.20)
    seller_term_months: int = Field(360, ge=1, le=480)
    balloon_month: int | None = Field(60, ge=1, le=480)
    monthly_expenses: float = Field(0, ge=0)
    vacancy_rate: float = Field(0.08, ge=0, le=1.0)
    closing_costs_pct: float = Field(0.02, ge=0, le=0.10)


class HardMoneyBridgeRequest(BaseModel):
    purchase_price: float = Field(..., gt=0)
    rehab_cost: float = Field(..., ge=0)
    arv: float = Field(..., gt=0)
    loan_to_cost_pct: float = Field(0.85, ge=0.1, le=1.0)
    interest_rate: float = Field(0.12, ge=0, le=0.30)
    points: float = Field(2.0, ge=0, le=10)
    term_months: int = Field(12, ge=1, le=36)
    interest_only: bool = True
    refi_after_months: int | None = Field(6, ge=1, le=36)
    refi_rate: float = Field(0.07, ge=0, le=0.20)
    refi_ltv: float = Field(0.75, ge=0.1, le=1.0)
    refi_term_years: int = Field(30, ge=1, le=40)
    monthly_rent_after_refi: float = Field(0, ge=0)
    monthly_expenses: float = Field(0, ge=0)
    vacancy_rate: float = Field(0.08, ge=0, le=1.0)


class MAORequest(BaseModel):
    arv: float = Field(..., gt=0)
    rehab_cost: float = Field(..., ge=0)
    profit_margin: float = Field(0.30, ge=0.05, le=0.60)
    closing_costs_pct: float = Field(0.03, ge=0, le=0.10)
    hold_costs: float = Field(0, ge=0)


class IRRRequest(BaseModel):
    cash_flows: list[float] = Field(..., min_length=2, description="Periodic cash flows, index 0 = initial investment (negative)")


# ---------------------------------------------------------------------------
# Scenario Comparison
# ---------------------------------------------------------------------------


class ScenarioComparisonRequest(BaseModel):
    property_data: dict[str, Any] = Field(
        ...,
        description="Property info: purchase_price, arv, rehab_cost, monthly_rent, property_value",
    )
    assumptions: dict[str, Any] = Field(
        default_factory=dict,
        description="Per-model assumption overrides keyed by model name",
    )
    models: list[str] | None = Field(
        None,
        description="Models to run. Omit for all 8.",
    )


# ---------------------------------------------------------------------------
# Response schemas
# ---------------------------------------------------------------------------


class FinancingModelResponse(BaseModel):
    """Generic response wrapper for any single financing model result."""

    model: str
    result: dict[str, Any]


class MAOResponse(BaseModel):
    mao: float
    arv: float
    profit_margin: float
    rehab_cost: float
    closing_costs: float
    hold_costs: float
    profit_target: float


class IRRResponse(BaseModel):
    irr: float | None
    cash_flows: list[float]


class ScenarioSummaryItem(BaseModel):
    model: str
    cash_on_cash_return: float | None = None
    roi: float | None = None
    monthly_cash_flow: float | None = None
    net_profit: float | None = None
    irr: float | None = None
    cash_invested: float | None = None


class ScenarioComparisonResponse(BaseModel):
    property_data: dict[str, Any]
    models_run: int
    summary: list[ScenarioSummaryItem]
    details: list[dict[str, Any]]
    errors: list[dict[str, str]]
