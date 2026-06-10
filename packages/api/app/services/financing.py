"""Financing engine — eight investment models, MAO calculator, and IRR.

All functions are **pure**: deterministic, no DB calls, no side effects.
Each model takes property data + assumptions and returns a structured projection.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _monthly_payment(principal: float, annual_rate: float, months: int) -> float:
    """Standard amortization monthly payment (P&I)."""
    if annual_rate <= 0 or months <= 0:
        return principal / max(months, 1)
    r = annual_rate / 12.0
    return principal * (r * (1 + r) ** months) / ((1 + r) ** months - 1)


def _loan_balance(principal: float, annual_rate: float, months_total: int, months_paid: int) -> float:
    """Remaining balance after *months_paid* payments on an amortizing loan."""
    if annual_rate <= 0:
        return principal * max(0, 1 - months_paid / max(months_total, 1))
    r = annual_rate / 12.0
    return principal * ((1 + r) ** months_total - (1 + r) ** months_paid) / ((1 + r) ** months_total - 1)


def _amortization_schedule(
    principal: float, annual_rate: float, months: int, *, balloon_month: int | None = None
) -> list[dict[str, Any]]:
    """Build a month-by-month amortization schedule.

    If *balloon_month* is set, the remaining balance becomes due at that month.
    """
    schedule: list[dict[str, Any]] = []
    balance = principal
    r = annual_rate / 12.0 if annual_rate > 0 else 0.0
    pmt = _monthly_payment(principal, annual_rate, months)

    for m in range(1, months + 1):
        interest = balance * r
        principal_portion = pmt - interest
        balance -= principal_portion
        if balance < 0:
            balance = 0.0

        entry: dict[str, Any] = {
            "month": m,
            "payment": round(pmt, 2),
            "principal": round(principal_portion, 2),
            "interest": round(interest, 2),
            "balance": round(balance, 2),
        }

        if balloon_month and m == balloon_month:
            entry["balloon_due"] = round(balance, 2)
            schedule.append(entry)
            break

        schedule.append(entry)

    return schedule


# ---------------------------------------------------------------------------
# IRR Calculator
# ---------------------------------------------------------------------------

def calculate_irr(cash_flows: list[float], *, max_iter: int = 200, tol: float = 1e-8) -> float | None:
    """Newton-Raphson IRR for irregular periodic cash flows.

    cash_flows[0] is typically the initial investment (negative).
    Returns annualised IRR as a decimal (e.g. 0.15 = 15%), or None if no convergence.
    """
    if not cash_flows or all(cf == 0 for cf in cash_flows):
        return None

    # Initial guess based on total return
    total_return = sum(cash_flows)
    n = len(cash_flows) - 1
    if n <= 0:
        return None

    # Start with a simple guess
    guess = 0.1

    for _ in range(max_iter):
        npv = 0.0
        dnpv = 0.0
        for t, cf in enumerate(cash_flows):
            denom = (1 + guess) ** t
            if denom == 0:
                break
            npv += cf / denom
            if t > 0:
                dnpv -= t * cf / ((1 + guess) ** (t + 1))

        if abs(dnpv) < 1e-14:
            break

        new_guess = guess - npv / dnpv

        # Clamp to avoid divergence
        if new_guess < -0.99:
            new_guess = -0.99
        if new_guess > 10.0:
            new_guess = 10.0

        if abs(new_guess - guess) < tol:
            return round(new_guess, 6)
        guess = new_guess

    return None


# ---------------------------------------------------------------------------
# MAO (Maximum Allowable Offer)
# ---------------------------------------------------------------------------

def calculate_mao(
    arv: float,
    rehab_cost: float,
    *,
    profit_margin: float = 0.30,
    closing_costs_pct: float = 0.03,
    hold_costs: float = 0.0,
) -> dict[str, Any]:
    """MAO = ARV * (1 - profit_margin) - rehab_cost - closing_costs - hold_costs.

    Returns MAO breakdown with each component.
    """
    closing_costs = arv * closing_costs_pct
    mao = arv * (1.0 - profit_margin) - rehab_cost - closing_costs - hold_costs

    return {
        "mao": round(max(0, mao), 2),
        "arv": round(arv, 2),
        "profit_margin": profit_margin,
        "rehab_cost": round(rehab_cost, 2),
        "closing_costs": round(closing_costs, 2),
        "hold_costs": round(hold_costs, 2),
        "profit_target": round(arv * profit_margin, 2),
    }


# ---------------------------------------------------------------------------
# 1. Fix & Flip
# ---------------------------------------------------------------------------

def fix_and_flip(
    purchase_price: float,
    rehab_cost: float,
    arv: float,
    *,
    hold_months: int = 6,
    monthly_hold_cost: float = 0.0,
    buying_closing_pct: float = 0.02,
    selling_closing_pct: float = 0.06,
    loan_amount: float = 0.0,
    loan_rate: float = 0.0,
) -> dict[str, Any]:
    """Fix & Flip projection.

    Returns purchase + rehab cost, hold costs, selling costs, net profit, ROI.
    """
    buying_closing = purchase_price * buying_closing_pct
    selling_closing = arv * selling_closing_pct
    total_hold_costs = monthly_hold_cost * hold_months

    # Financing costs during hold
    if loan_amount > 0 and loan_rate > 0:
        monthly_interest = loan_amount * (loan_rate / 12.0)
        financing_cost = monthly_interest * hold_months
    else:
        financing_cost = 0.0

    total_cost = purchase_price + rehab_cost + buying_closing + total_hold_costs + financing_cost
    total_selling_costs = selling_closing
    net_profit = arv - total_cost - total_selling_costs
    cash_invested = purchase_price + rehab_cost + buying_closing - loan_amount
    if cash_invested < 0:
        cash_invested = 0.01  # avoid division by zero

    roi = net_profit / cash_invested

    # Cash flows for IRR: initial outlay, monthly hold costs, final sale
    cf: list[float] = [-cash_invested]
    for _ in range(hold_months - 1):
        cf.append(-(monthly_hold_cost + (monthly_interest if loan_amount > 0 else 0.0)))
    # Final month: sale proceeds minus selling costs minus loan payoff
    final = arv - total_selling_costs - loan_amount - monthly_hold_cost
    if loan_amount > 0:
        final -= monthly_interest if loan_rate > 0 else 0.0
    cf.append(final)

    irr = calculate_irr(cf)
    mao = calculate_mao(arv, rehab_cost, hold_costs=total_hold_costs + financing_cost)

    return {
        "model": "fix_and_flip",
        "purchase_price": round(purchase_price, 2),
        "rehab_cost": round(rehab_cost, 2),
        "arv": round(arv, 2),
        "buying_closing_costs": round(buying_closing, 2),
        "selling_closing_costs": round(selling_closing, 2),
        "total_hold_costs": round(total_hold_costs, 2),
        "financing_cost": round(financing_cost, 2),
        "total_cost": round(total_cost, 2),
        "net_profit": round(net_profit, 2),
        "roi": round(roi, 4),
        "annualised_roi": round(roi * (12.0 / max(hold_months, 1)), 4),
        "irr": irr,
        "mao": mao,
        "hold_months": hold_months,
        "cash_invested": round(cash_invested, 2),
    }


# ---------------------------------------------------------------------------
# 2. BRRRR (Buy, Rehab, Rent, Refinance, Repeat)
# ---------------------------------------------------------------------------

def brrrr(
    purchase_price: float,
    rehab_cost: float,
    arv: float,
    monthly_rent: float,
    *,
    hold_months_before_refi: int = 6,
    refi_ltv: float = 0.75,
    refi_rate: float = 0.07,
    refi_term_years: int = 30,
    monthly_expenses: float = 0.0,
    vacancy_rate: float = 0.08,
    buying_closing_pct: float = 0.02,
    initial_loan_amount: float = 0.0,
    initial_loan_rate: float = 0.0,
) -> dict[str, Any]:
    """BRRRR model — cash-on-cash return after refinance."""
    buying_closing = purchase_price * buying_closing_pct
    total_initial = purchase_price + rehab_cost + buying_closing

    # Initial financing costs during rehab
    if initial_loan_amount > 0 and initial_loan_rate > 0:
        init_monthly_interest = initial_loan_amount * (initial_loan_rate / 12.0)
        init_financing_cost = init_monthly_interest * hold_months_before_refi
    else:
        init_financing_cost = 0.0

    cash_in = total_initial - initial_loan_amount + init_financing_cost

    # Refinance
    refi_amount = arv * refi_ltv
    cash_out_refi = refi_amount - initial_loan_amount  # pay off initial loan
    cash_left_in = cash_in - cash_out_refi

    # Monthly cash flow post-refi
    refi_payment = _monthly_payment(refi_amount, refi_rate, refi_term_years * 12)
    effective_rent = monthly_rent * (1 - vacancy_rate)
    monthly_cash_flow = effective_rent - monthly_expenses - refi_payment

    # Annual metrics
    annual_cash_flow = monthly_cash_flow * 12
    cash_on_cash = annual_cash_flow / max(cash_left_in, 0.01)

    # IRR: initial investment, rental income months, then ongoing
    cf: list[float] = [-max(cash_left_in, 0.01)]
    for _ in range(12):
        cf.append(monthly_cash_flow)
    irr = calculate_irr(cf)

    return {
        "model": "brrrr",
        "purchase_price": round(purchase_price, 2),
        "rehab_cost": round(rehab_cost, 2),
        "arv": round(arv, 2),
        "total_initial_investment": round(total_initial, 2),
        "cash_in_before_refi": round(cash_in, 2),
        "refi_amount": round(refi_amount, 2),
        "cash_out_refi": round(cash_out_refi, 2),
        "cash_left_in_deal": round(max(cash_left_in, 0), 2),
        "refi_monthly_payment": round(refi_payment, 2),
        "monthly_rent": round(monthly_rent, 2),
        "effective_rent": round(effective_rent, 2),
        "monthly_expenses": round(monthly_expenses, 2),
        "monthly_cash_flow": round(monthly_cash_flow, 2),
        "annual_cash_flow": round(annual_cash_flow, 2),
        "cash_on_cash_return": round(cash_on_cash, 4),
        "irr": irr,
        "refi_ltv": refi_ltv,
        "refi_rate": refi_rate,
        "refi_term_years": refi_term_years,
    }


# ---------------------------------------------------------------------------
# 3. Buy & Hold (Long-Term Rental)
# ---------------------------------------------------------------------------

def buy_and_hold(
    purchase_price: float,
    monthly_rent: float,
    *,
    down_payment_pct: float = 0.20,
    loan_rate: float = 0.07,
    loan_term_years: int = 30,
    monthly_expenses: float = 0.0,
    vacancy_rate: float = 0.08,
    annual_appreciation: float = 0.03,
    annual_rent_growth: float = 0.02,
    closing_costs_pct: float = 0.03,
) -> dict[str, Any]:
    """Buy & Hold projection — monthly cash flow, cap rate, annual ROI, multi-year projections."""
    down_payment = purchase_price * down_payment_pct
    closing_costs = purchase_price * closing_costs_pct
    loan_amount = purchase_price - down_payment
    cash_invested = down_payment + closing_costs

    mortgage_payment = _monthly_payment(loan_amount, loan_rate, loan_term_years * 12)
    effective_rent = monthly_rent * (1 - vacancy_rate)
    monthly_cash_flow = effective_rent - monthly_expenses - mortgage_payment

    # Cap rate (based on purchase price)
    annual_noi = (effective_rent - monthly_expenses) * 12
    cap_rate = annual_noi / purchase_price if purchase_price > 0 else 0

    annual_cash_flow = monthly_cash_flow * 12
    cash_on_cash = annual_cash_flow / max(cash_invested, 0.01)

    # Multi-year projections
    projections: list[dict[str, Any]] = []
    for year in [5, 10, 30]:
        prop_value = purchase_price * (1 + annual_appreciation) ** year
        rent_at_year = monthly_rent * (1 + annual_rent_growth) ** year
        eff_rent_yr = rent_at_year * (1 - vacancy_rate)
        noi_yr = (eff_rent_yr - monthly_expenses) * 12
        months_paid = min(year * 12, loan_term_years * 12)
        remaining_balance = _loan_balance(loan_amount, loan_rate, loan_term_years * 12, months_paid)
        equity = prop_value - remaining_balance
        total_cash_flow = sum(
            ((monthly_rent * (1 + annual_rent_growth) ** (y // 12) * (1 - vacancy_rate))
             - monthly_expenses - mortgage_payment)
            for y in range(year * 12)
        )
        projections.append({
            "year": year,
            "property_value": round(prop_value, 2),
            "monthly_rent": round(rent_at_year, 2),
            "annual_noi": round(noi_yr, 2),
            "equity": round(equity, 2),
            "cumulative_cash_flow": round(total_cash_flow, 2),
        })

    # IRR over 10 years: initial outlay, annual cash flows, sale at year 10
    cf: list[float] = [-cash_invested]
    for yr in range(1, 11):
        rent_yr = monthly_rent * (1 + annual_rent_growth) ** yr
        eff = rent_yr * (1 - vacancy_rate)
        annual_cf = (eff - monthly_expenses) * 12 - mortgage_payment * 12
        cf.append(annual_cf)
    # Add sale proceeds at year 10
    sale_price_10 = purchase_price * (1 + annual_appreciation) ** 10
    remaining_10 = _loan_balance(loan_amount, loan_rate, loan_term_years * 12, 120)
    cf[-1] += sale_price_10 - remaining_10
    irr = calculate_irr(cf)

    return {
        "model": "buy_and_hold",
        "purchase_price": round(purchase_price, 2),
        "down_payment": round(down_payment, 2),
        "closing_costs": round(closing_costs, 2),
        "cash_invested": round(cash_invested, 2),
        "loan_amount": round(loan_amount, 2),
        "mortgage_payment": round(mortgage_payment, 2),
        "monthly_rent": round(monthly_rent, 2),
        "effective_rent": round(effective_rent, 2),
        "monthly_expenses": round(monthly_expenses, 2),
        "monthly_cash_flow": round(monthly_cash_flow, 2),
        "annual_cash_flow": round(annual_cash_flow, 2),
        "cap_rate": round(cap_rate, 4),
        "cash_on_cash_return": round(cash_on_cash, 4),
        "irr": irr,
        "projections": projections,
    }


# ---------------------------------------------------------------------------
# 4. Short-Term Rental (STR / Airbnb)
# ---------------------------------------------------------------------------

def short_term_rental(
    purchase_price: float,
    nightly_rate: float,
    *,
    occupancy_rate: float = 0.70,
    down_payment_pct: float = 0.20,
    loan_rate: float = 0.07,
    loan_term_years: int = 30,
    monthly_expenses: float = 0.0,
    platform_fee_pct: float = 0.03,
    cleaning_fee_per_turn: float = 0.0,
    avg_stay_nights: float = 3.0,
    seasonal_adjustments: dict[str, float] | None = None,
    closing_costs_pct: float = 0.03,
) -> dict[str, Any]:
    """Short-Term Rental projection with seasonal adjustments."""
    down_payment = purchase_price * down_payment_pct
    closing_costs = purchase_price * closing_costs_pct
    loan_amount = purchase_price - down_payment
    cash_invested = down_payment + closing_costs
    mortgage_payment = _monthly_payment(loan_amount, loan_rate, loan_term_years * 12)

    # Default seasonal adjustments (multipliers by quarter)
    seasons = seasonal_adjustments or {
        "q1": 0.80, "q2": 1.10, "q3": 1.20, "q4": 0.90,
    }

    monthly_breakdown: list[dict[str, Any]] = []
    annual_gross = 0.0
    annual_net = 0.0
    quarter_map = {1: "q1", 2: "q1", 3: "q1", 4: "q2", 5: "q2", 6: "q2",
                   7: "q3", 8: "q3", 9: "q3", 10: "q4", 11: "q4", 12: "q4"}

    for month in range(1, 13):
        days = 30
        q = quarter_map[month]
        adj = seasons.get(q, 1.0)
        adj_rate = nightly_rate * adj
        occupied_nights = days * occupancy_rate
        gross = occupied_nights * adj_rate
        platform_fees = gross * platform_fee_pct
        turns = occupied_nights / max(avg_stay_nights, 1)
        cleaning = turns * cleaning_fee_per_turn
        net = gross - platform_fees - cleaning - monthly_expenses - mortgage_payment
        annual_gross += gross
        annual_net += net
        monthly_breakdown.append({
            "month": month,
            "nightly_rate": round(adj_rate, 2),
            "occupied_nights": round(occupied_nights, 1),
            "gross_revenue": round(gross, 2),
            "platform_fees": round(platform_fees, 2),
            "cleaning_costs": round(cleaning, 2),
            "net_income": round(net, 2),
        })

    cap_rate = annual_net / purchase_price if purchase_price > 0 else 0
    cash_on_cash = annual_net / max(cash_invested, 0.01)

    cf: list[float] = [-cash_invested]
    for entry in monthly_breakdown:
        cf.append(entry["net_income"])
    irr = calculate_irr(cf)

    return {
        "model": "short_term_rental",
        "purchase_price": round(purchase_price, 2),
        "down_payment": round(down_payment, 2),
        "cash_invested": round(cash_invested, 2),
        "nightly_rate": round(nightly_rate, 2),
        "occupancy_rate": occupancy_rate,
        "mortgage_payment": round(mortgage_payment, 2),
        "annual_gross_revenue": round(annual_gross, 2),
        "annual_net_income": round(annual_net, 2),
        "cap_rate": round(cap_rate, 4),
        "cash_on_cash_return": round(cash_on_cash, 4),
        "irr": irr,
        "monthly_breakdown": monthly_breakdown,
        "seasonal_adjustments": seasons,
    }


# ---------------------------------------------------------------------------
# 5. Wholesale
# ---------------------------------------------------------------------------

def wholesale(
    arv: float,
    rehab_cost: float,
    *,
    assignment_fee: float = 10_000.0,
    buyer_profit_margin: float = 0.30,
    closing_costs_pct: float = 0.01,
    earnest_money: float = 1_000.0,
) -> dict[str, Any]:
    """Wholesale deal analysis — assignment fee, MAO, buyer's spread."""
    mao_result = calculate_mao(arv, rehab_cost, profit_margin=buyer_profit_margin)
    mao_price = mao_result["mao"]

    # Wholesaler's contract price should be below MAO minus assignment fee
    contract_price = mao_price - assignment_fee
    buyer_price = contract_price + assignment_fee
    closing_costs = contract_price * closing_costs_pct

    # Buyer's expected profit
    buyers_total_cost = buyer_price + rehab_cost + (arv * 0.06)  # 6% selling costs
    buyers_spread = arv - buyers_total_cost

    wholesaler_profit = assignment_fee - closing_costs - earnest_money
    roi = wholesaler_profit / max(earnest_money, 0.01)

    return {
        "model": "wholesale",
        "arv": round(arv, 2),
        "rehab_cost": round(rehab_cost, 2),
        "mao": round(mao_price, 2),
        "contract_price": round(max(contract_price, 0), 2),
        "assignment_fee": round(assignment_fee, 2),
        "buyer_price": round(buyer_price, 2),
        "buyers_spread": round(buyers_spread, 2),
        "earnest_money": round(earnest_money, 2),
        "closing_costs": round(closing_costs, 2),
        "wholesaler_profit": round(wholesaler_profit, 2),
        "roi": round(roi, 4),
    }


# ---------------------------------------------------------------------------
# 6. Subject-To (Existing Mortgage Takeover)
# ---------------------------------------------------------------------------

def subject_to(
    property_value: float,
    existing_mortgage_balance: float,
    existing_mortgage_rate: float,
    existing_mortgage_remaining_months: int,
    monthly_rent: float,
    *,
    cash_to_seller: float = 0.0,
    monthly_expenses: float = 0.0,
    vacancy_rate: float = 0.08,
    closing_costs: float = 0.0,
    wrap_rate: float | None = None,
    wrap_term_months: int | None = None,
) -> dict[str, Any]:
    """Subject-To analysis — existing mortgage takeover, equity position, cash flow.

    Optional wrap mortgage: sell on contract at a higher rate.
    """
    equity = property_value - existing_mortgage_balance
    cash_invested = cash_to_seller + closing_costs

    existing_payment = _monthly_payment(
        existing_mortgage_balance, existing_mortgage_rate, existing_mortgage_remaining_months
    )
    effective_rent = monthly_rent * (1 - vacancy_rate)
    monthly_cash_flow = effective_rent - monthly_expenses - existing_payment

    # Wrap mortgage (sell on contract)
    wrap_info: dict[str, Any] | None = None
    if wrap_rate is not None and wrap_term_months is not None:
        wrap_payment = _monthly_payment(property_value, wrap_rate, wrap_term_months)
        wrap_spread = wrap_payment - existing_payment
        wrap_info = {
            "wrap_rate": wrap_rate,
            "wrap_term_months": wrap_term_months,
            "wrap_payment": round(wrap_payment, 2),
            "monthly_spread": round(wrap_spread, 2),
            "annual_spread": round(wrap_spread * 12, 2),
        }

    annual_cash_flow = monthly_cash_flow * 12
    cash_on_cash = annual_cash_flow / max(cash_invested, 0.01)

    cf: list[float] = [-max(cash_invested, 0.01)]
    for _ in range(12):
        cf.append(monthly_cash_flow)
    irr = calculate_irr(cf)

    return {
        "model": "subject_to",
        "property_value": round(property_value, 2),
        "existing_mortgage_balance": round(existing_mortgage_balance, 2),
        "existing_mortgage_rate": existing_mortgage_rate,
        "existing_payment": round(existing_payment, 2),
        "equity_position": round(equity, 2),
        "cash_to_seller": round(cash_to_seller, 2),
        "closing_costs": round(closing_costs, 2),
        "cash_invested": round(cash_invested, 2),
        "monthly_rent": round(monthly_rent, 2),
        "effective_rent": round(effective_rent, 2),
        "monthly_cash_flow": round(monthly_cash_flow, 2),
        "annual_cash_flow": round(annual_cash_flow, 2),
        "cash_on_cash_return": round(cash_on_cash, 4),
        "irr": irr,
        "wrap_mortgage": wrap_info,
    }


# ---------------------------------------------------------------------------
# 7. Seller Financing
# ---------------------------------------------------------------------------

def seller_financing(
    purchase_price: float,
    monthly_rent: float,
    *,
    down_payment_pct: float = 0.10,
    seller_rate: float = 0.06,
    seller_term_months: int = 360,
    balloon_month: int | None = 60,
    monthly_expenses: float = 0.0,
    vacancy_rate: float = 0.08,
    closing_costs_pct: float = 0.02,
) -> dict[str, Any]:
    """Seller Financing — custom terms, balloon payment, amortization schedule."""
    down_payment = purchase_price * down_payment_pct
    closing_costs = purchase_price * closing_costs_pct
    financed_amount = purchase_price - down_payment
    cash_invested = down_payment + closing_costs

    seller_payment = _monthly_payment(financed_amount, seller_rate, seller_term_months)
    effective_rent = monthly_rent * (1 - vacancy_rate)
    monthly_cash_flow = effective_rent - monthly_expenses - seller_payment

    # Balloon balance
    balloon_balance: float | None = None
    if balloon_month and balloon_month < seller_term_months:
        balloon_balance = _loan_balance(financed_amount, seller_rate, seller_term_months, balloon_month)

    schedule = _amortization_schedule(
        financed_amount, seller_rate, seller_term_months, balloon_month=balloon_month
    )

    annual_cash_flow = monthly_cash_flow * 12
    cash_on_cash = annual_cash_flow / max(cash_invested, 0.01)

    cf: list[float] = [-cash_invested]
    for _ in range(min(balloon_month or 12, 12)):
        cf.append(monthly_cash_flow)
    irr = calculate_irr(cf)

    return {
        "model": "seller_financing",
        "purchase_price": round(purchase_price, 2),
        "down_payment": round(down_payment, 2),
        "financed_amount": round(financed_amount, 2),
        "cash_invested": round(cash_invested, 2),
        "seller_rate": seller_rate,
        "seller_term_months": seller_term_months,
        "monthly_payment": round(seller_payment, 2),
        "monthly_rent": round(monthly_rent, 2),
        "effective_rent": round(effective_rent, 2),
        "monthly_cash_flow": round(monthly_cash_flow, 2),
        "annual_cash_flow": round(annual_cash_flow, 2),
        "cash_on_cash_return": round(cash_on_cash, 4),
        "irr": irr,
        "balloon_month": balloon_month,
        "balloon_balance": round(balloon_balance, 2) if balloon_balance is not None else None,
        "amortization_schedule": schedule[:12],  # first 12 months only in response
        "amortization_schedule_length": len(schedule),
    }


# ---------------------------------------------------------------------------
# 8. Hard Money / Bridge Loan
# ---------------------------------------------------------------------------

def hard_money_bridge(
    purchase_price: float,
    rehab_cost: float,
    arv: float,
    *,
    loan_to_cost_pct: float = 0.85,
    interest_rate: float = 0.12,
    points: float = 2.0,
    term_months: int = 12,
    interest_only: bool = True,
    refi_after_months: int | None = 6,
    refi_rate: float = 0.07,
    refi_ltv: float = 0.75,
    refi_term_years: int = 30,
    monthly_rent_after_refi: float = 0.0,
    monthly_expenses: float = 0.0,
    vacancy_rate: float = 0.08,
) -> dict[str, Any]:
    """Hard Money / Bridge loan analysis — points, interest-only, total cost of capital."""
    total_project_cost = purchase_price + rehab_cost
    loan_amount = total_project_cost * loan_to_cost_pct
    cash_needed = total_project_cost - loan_amount

    # Points (origination fee)
    origination_fee = loan_amount * (points / 100.0)

    # Interest-only payments
    if interest_only:
        monthly_payment = loan_amount * (interest_rate / 12.0)
    else:
        monthly_payment = _monthly_payment(loan_amount, interest_rate, term_months)

    hold_months = refi_after_months or term_months
    total_interest = monthly_payment * hold_months
    total_cost_of_capital = origination_fee + total_interest

    # Refi scenario
    refi_info: dict[str, Any] | None = None
    if refi_after_months and monthly_rent_after_refi > 0:
        refi_amount = arv * refi_ltv
        refi_payment = _monthly_payment(refi_amount, refi_rate, refi_term_years * 12)
        payoff = loan_amount  # pay off hard money
        cash_out = refi_amount - payoff
        effective_rent = monthly_rent_after_refi * (1 - vacancy_rate)
        post_refi_cash_flow = effective_rent - monthly_expenses - refi_payment

        refi_info = {
            "refi_month": refi_after_months,
            "refi_amount": round(refi_amount, 2),
            "refi_payment": round(refi_payment, 2),
            "cash_out": round(cash_out, 2),
            "post_refi_monthly_cash_flow": round(post_refi_cash_flow, 2),
        }

    # Cash flows for IRR
    cf: list[float] = [-(cash_needed + origination_fee)]
    for m in range(1, hold_months + 1):
        cf.append(-monthly_payment)
    if refi_info:
        # At refi: get cash out and start earning
        cf[-1] += refi_info["cash_out"] + loan_amount  # pay off hard money from refi
        for _ in range(6):
            cf.append(refi_info["post_refi_monthly_cash_flow"])
    else:
        # Exit via sale
        selling_costs = arv * 0.06
        cf[-1] += arv - loan_amount - selling_costs

    irr = calculate_irr(cf)

    return {
        "model": "hard_money_bridge",
        "purchase_price": round(purchase_price, 2),
        "rehab_cost": round(rehab_cost, 2),
        "arv": round(arv, 2),
        "loan_amount": round(loan_amount, 2),
        "loan_to_cost_pct": loan_to_cost_pct,
        "interest_rate": interest_rate,
        "points": points,
        "origination_fee": round(origination_fee, 2),
        "term_months": term_months,
        "interest_only": interest_only,
        "monthly_payment": round(monthly_payment, 2),
        "total_interest": round(total_interest, 2),
        "total_cost_of_capital": round(total_cost_of_capital, 2),
        "cash_needed": round(cash_needed, 2),
        "irr": irr,
        "refinance": refi_info,
    }


# ---------------------------------------------------------------------------
# Scenario Comparison
# ---------------------------------------------------------------------------

ALL_MODELS = [
    "fix_and_flip",
    "brrrr",
    "buy_and_hold",
    "short_term_rental",
    "wholesale",
    "subject_to",
    "seller_financing",
    "hard_money_bridge",
]


def compare_scenarios(
    property_data: dict[str, Any],
    assumptions: dict[str, Any],
    *,
    models: list[str] | None = None,
) -> dict[str, Any]:
    """Run multiple financing models against the same property and return side-by-side comparison.

    property_data should include: purchase_price, arv, rehab_cost, monthly_rent, etc.
    assumptions can override per-model defaults.
    """
    requested = models or ALL_MODELS
    results: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []

    pp = property_data.get("purchase_price", 0)
    arv = property_data.get("arv", 0)
    rehab = property_data.get("rehab_cost", 0)
    rent = property_data.get("monthly_rent", 0)

    for model_name in requested:
        try:
            if model_name == "fix_and_flip":
                r = fix_and_flip(pp, rehab, arv, **assumptions.get("fix_and_flip", {}))
            elif model_name == "brrrr":
                r = brrrr(pp, rehab, arv, rent, **assumptions.get("brrrr", {}))
            elif model_name == "buy_and_hold":
                r = buy_and_hold(pp, rent, **assumptions.get("buy_and_hold", {}))
            elif model_name == "short_term_rental":
                nightly = assumptions.get("short_term_rental", {}).get("nightly_rate", rent / 30 * 2)
                a = {k: v for k, v in assumptions.get("short_term_rental", {}).items() if k != "nightly_rate"}
                r = short_term_rental(pp, nightly, **a)
            elif model_name == "wholesale":
                r = wholesale(arv, rehab, **assumptions.get("wholesale", {}))
            elif model_name == "subject_to":
                sub_to_args = assumptions.get("subject_to", {})
                r = subject_to(
                    property_data.get("property_value", pp),
                    sub_to_args.get("existing_mortgage_balance", pp * 0.7),
                    sub_to_args.get("existing_mortgage_rate", 0.05),
                    sub_to_args.get("existing_mortgage_remaining_months", 300),
                    rent,
                    **{k: v for k, v in sub_to_args.items()
                       if k not in ("existing_mortgage_balance", "existing_mortgage_rate",
                                    "existing_mortgage_remaining_months")},
                )
            elif model_name == "seller_financing":
                r = seller_financing(pp, rent, **assumptions.get("seller_financing", {}))
            elif model_name == "hard_money_bridge":
                r = hard_money_bridge(pp, rehab, arv, **assumptions.get("hard_money_bridge", {}))
            else:
                errors.append({"model": model_name, "error": f"Unknown model: {model_name}"})
                continue
            results.append(r)
        except Exception as exc:
            errors.append({"model": model_name, "error": str(exc)})

    # Summary comparison
    summary: list[dict[str, Any]] = []
    for r in results:
        s: dict[str, Any] = {"model": r["model"]}
        if "cash_on_cash_return" in r:
            s["cash_on_cash_return"] = r["cash_on_cash_return"]
        if "roi" in r:
            s["roi"] = r["roi"]
        if "monthly_cash_flow" in r:
            s["monthly_cash_flow"] = r["monthly_cash_flow"]
        if "net_profit" in r:
            s["net_profit"] = r["net_profit"]
        if "irr" in r:
            s["irr"] = r["irr"]
        if "cash_invested" in r:
            s["cash_invested"] = r["cash_invested"]
        if "wholesaler_profit" in r:
            s["net_profit"] = r["wholesaler_profit"]
            s["cash_invested"] = r["earnest_money"]
        summary.append(s)

    # Sort by IRR descending (None last)
    summary.sort(key=lambda x: x.get("irr") or -999, reverse=True)

    return {
        "property_data": property_data,
        "models_run": len(results),
        "summary": summary,
        "details": results,
        "errors": errors,
    }
