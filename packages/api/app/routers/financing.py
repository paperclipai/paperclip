"""Financing engine endpoints — 8 models, MAO, IRR, scenario comparison."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.auth import CurrentUser, get_current_user
from app.schemas.financing import (
    BRRRRRequest,
    BuyAndHoldRequest,
    FinancingModelResponse,
    FixAndFlipRequest,
    HardMoneyBridgeRequest,
    IRRRequest,
    IRRResponse,
    MAORequest,
    MAOResponse,
    ScenarioComparisonRequest,
    ScenarioComparisonResponse,
    SellerFinancingRequest,
    ShortTermRentalRequest,
    SubjectToRequest,
    WholesaleRequest,
)
from app.services.financing import (
    brrrr,
    buy_and_hold,
    calculate_irr,
    calculate_mao,
    compare_scenarios,
    fix_and_flip,
    hard_money_bridge,
    seller_financing,
    short_term_rental,
    subject_to,
    wholesale,
)

router = APIRouter(prefix="/financing", tags=["financing"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _ensure_tenant(user: CurrentUser) -> str:
    return user.effective_tenant_id


# ---------------------------------------------------------------------------
# Individual model endpoints
# ---------------------------------------------------------------------------


@router.post("/fix-and-flip", response_model=FinancingModelResponse)
async def run_fix_and_flip(
    body: FixAndFlipRequest,
    user: CurrentUser = Depends(get_current_user),
) -> FinancingModelResponse:
    """Run Fix & Flip financing model."""
    _ensure_tenant(user)
    result = fix_and_flip(
        body.purchase_price,
        body.rehab_cost,
        body.arv,
        hold_months=body.hold_months,
        monthly_hold_cost=body.monthly_hold_cost,
        buying_closing_pct=body.buying_closing_pct,
        selling_closing_pct=body.selling_closing_pct,
        loan_amount=body.loan_amount,
        loan_rate=body.loan_rate,
    )
    return FinancingModelResponse(model="fix_and_flip", result=result)


@router.post("/brrrr", response_model=FinancingModelResponse)
async def run_brrrr(
    body: BRRRRRequest,
    user: CurrentUser = Depends(get_current_user),
) -> FinancingModelResponse:
    """Run BRRRR financing model."""
    _ensure_tenant(user)
    result = brrrr(
        body.purchase_price,
        body.rehab_cost,
        body.arv,
        body.monthly_rent,
        hold_months_before_refi=body.hold_months_before_refi,
        refi_ltv=body.refi_ltv,
        refi_rate=body.refi_rate,
        refi_term_years=body.refi_term_years,
        monthly_expenses=body.monthly_expenses,
        vacancy_rate=body.vacancy_rate,
        buying_closing_pct=body.buying_closing_pct,
        initial_loan_amount=body.initial_loan_amount,
        initial_loan_rate=body.initial_loan_rate,
    )
    return FinancingModelResponse(model="brrrr", result=result)


@router.post("/buy-and-hold", response_model=FinancingModelResponse)
async def run_buy_and_hold(
    body: BuyAndHoldRequest,
    user: CurrentUser = Depends(get_current_user),
) -> FinancingModelResponse:
    """Run Buy & Hold (long-term rental) financing model."""
    _ensure_tenant(user)
    result = buy_and_hold(
        body.purchase_price,
        body.monthly_rent,
        down_payment_pct=body.down_payment_pct,
        loan_rate=body.loan_rate,
        loan_term_years=body.loan_term_years,
        monthly_expenses=body.monthly_expenses,
        vacancy_rate=body.vacancy_rate,
        annual_appreciation=body.annual_appreciation,
        annual_rent_growth=body.annual_rent_growth,
        closing_costs_pct=body.closing_costs_pct,
    )
    return FinancingModelResponse(model="buy_and_hold", result=result)


@router.post("/short-term-rental", response_model=FinancingModelResponse)
async def run_short_term_rental(
    body: ShortTermRentalRequest,
    user: CurrentUser = Depends(get_current_user),
) -> FinancingModelResponse:
    """Run Short-Term Rental (Airbnb) financing model."""
    _ensure_tenant(user)
    result = short_term_rental(
        body.purchase_price,
        body.nightly_rate,
        occupancy_rate=body.occupancy_rate,
        down_payment_pct=body.down_payment_pct,
        loan_rate=body.loan_rate,
        loan_term_years=body.loan_term_years,
        monthly_expenses=body.monthly_expenses,
        platform_fee_pct=body.platform_fee_pct,
        cleaning_fee_per_turn=body.cleaning_fee_per_turn,
        avg_stay_nights=body.avg_stay_nights,
        seasonal_adjustments=body.seasonal_adjustments,
        closing_costs_pct=body.closing_costs_pct,
    )
    return FinancingModelResponse(model="short_term_rental", result=result)


@router.post("/wholesale", response_model=FinancingModelResponse)
async def run_wholesale(
    body: WholesaleRequest,
    user: CurrentUser = Depends(get_current_user),
) -> FinancingModelResponse:
    """Run Wholesale deal analysis."""
    _ensure_tenant(user)
    result = wholesale(
        body.arv,
        body.rehab_cost,
        assignment_fee=body.assignment_fee,
        buyer_profit_margin=body.buyer_profit_margin,
        closing_costs_pct=body.closing_costs_pct,
        earnest_money=body.earnest_money,
    )
    return FinancingModelResponse(model="wholesale", result=result)


@router.post("/subject-to", response_model=FinancingModelResponse)
async def run_subject_to(
    body: SubjectToRequest,
    user: CurrentUser = Depends(get_current_user),
) -> FinancingModelResponse:
    """Run Subject-To (existing mortgage takeover) analysis."""
    _ensure_tenant(user)
    result = subject_to(
        body.property_value,
        body.existing_mortgage_balance,
        body.existing_mortgage_rate,
        body.existing_mortgage_remaining_months,
        body.monthly_rent,
        cash_to_seller=body.cash_to_seller,
        monthly_expenses=body.monthly_expenses,
        vacancy_rate=body.vacancy_rate,
        closing_costs=body.closing_costs,
        wrap_rate=body.wrap_rate,
        wrap_term_months=body.wrap_term_months,
    )
    return FinancingModelResponse(model="subject_to", result=result)


@router.post("/seller-financing", response_model=FinancingModelResponse)
async def run_seller_financing(
    body: SellerFinancingRequest,
    user: CurrentUser = Depends(get_current_user),
) -> FinancingModelResponse:
    """Run Seller Financing model with custom terms and amortization."""
    _ensure_tenant(user)
    result = seller_financing(
        body.purchase_price,
        body.monthly_rent,
        down_payment_pct=body.down_payment_pct,
        seller_rate=body.seller_rate,
        seller_term_months=body.seller_term_months,
        balloon_month=body.balloon_month,
        monthly_expenses=body.monthly_expenses,
        vacancy_rate=body.vacancy_rate,
        closing_costs_pct=body.closing_costs_pct,
    )
    return FinancingModelResponse(model="seller_financing", result=result)


@router.post("/hard-money-bridge", response_model=FinancingModelResponse)
async def run_hard_money_bridge(
    body: HardMoneyBridgeRequest,
    user: CurrentUser = Depends(get_current_user),
) -> FinancingModelResponse:
    """Run Hard Money / Bridge loan analysis."""
    _ensure_tenant(user)
    result = hard_money_bridge(
        body.purchase_price,
        body.rehab_cost,
        body.arv,
        loan_to_cost_pct=body.loan_to_cost_pct,
        interest_rate=body.interest_rate,
        points=body.points,
        term_months=body.term_months,
        interest_only=body.interest_only,
        refi_after_months=body.refi_after_months,
        refi_rate=body.refi_rate,
        refi_ltv=body.refi_ltv,
        refi_term_years=body.refi_term_years,
        monthly_rent_after_refi=body.monthly_rent_after_refi,
        monthly_expenses=body.monthly_expenses,
        vacancy_rate=body.vacancy_rate,
    )
    return FinancingModelResponse(model="hard_money_bridge", result=result)


# ---------------------------------------------------------------------------
# MAO & IRR
# ---------------------------------------------------------------------------


@router.post("/mao", response_model=MAOResponse)
async def run_mao(
    body: MAORequest,
    user: CurrentUser = Depends(get_current_user),
) -> MAOResponse:
    """Calculate Maximum Allowable Offer."""
    _ensure_tenant(user)
    result = calculate_mao(
        body.arv,
        body.rehab_cost,
        profit_margin=body.profit_margin,
        closing_costs_pct=body.closing_costs_pct,
        hold_costs=body.hold_costs,
    )
    return MAOResponse(**result)


@router.post("/irr", response_model=IRRResponse)
async def run_irr(
    body: IRRRequest,
    user: CurrentUser = Depends(get_current_user),
) -> IRRResponse:
    """Calculate Internal Rate of Return from cash flows."""
    _ensure_tenant(user)
    irr = calculate_irr(body.cash_flows)
    return IRRResponse(irr=irr, cash_flows=body.cash_flows)


# ---------------------------------------------------------------------------
# Scenario Comparison
# ---------------------------------------------------------------------------


@router.post("/compare", response_model=ScenarioComparisonResponse)
async def compare_financing_scenarios(
    body: ScenarioComparisonRequest,
    user: CurrentUser = Depends(get_current_user),
) -> ScenarioComparisonResponse:
    """Run multiple financing models against the same property for side-by-side comparison.

    Provide property_data with keys: purchase_price, arv, rehab_cost, monthly_rent.
    Optionally provide per-model assumptions and select specific models to run.
    """
    _ensure_tenant(user)
    result = compare_scenarios(
        body.property_data,
        body.assumptions,
        models=body.models,
    )
    return ScenarioComparisonResponse(**result)
