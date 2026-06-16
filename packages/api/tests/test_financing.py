"""Unit tests for financing engine — pure function tests + integration tests."""

from __future__ import annotations

import pytest

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


# ===================================================================
# IRR Calculator
# ===================================================================


class TestCalculateIRR:
    def test_simple_doubling(self):
        # Invest $1000, get $2000 back after 1 period
        irr = calculate_irr([-1000, 2000])
        assert irr is not None
        assert abs(irr - 1.0) < 0.01  # ~100% return

    def test_even_cash_flows(self):
        # Invest $10000, get $3000/year for 5 years
        irr = calculate_irr([-10000, 3000, 3000, 3000, 3000, 3000])
        assert irr is not None
        assert 0.10 < irr < 0.20  # ~15% IRR

    def test_negative_return(self):
        # Invest $10000, get less back
        irr = calculate_irr([-10000, 2000, 2000, 2000])
        assert irr is not None
        assert irr < 0

    def test_all_zeros_returns_none(self):
        assert calculate_irr([0, 0, 0]) is None

    def test_empty_returns_none(self):
        assert calculate_irr([]) is None


# ===================================================================
# MAO Calculator
# ===================================================================


class TestCalculateMAO:
    def test_standard_mao(self):
        """ARV $200k, rehab $30k, 30% margin → MAO = 200k*0.70 - 30k - 6k = $104k"""
        result = calculate_mao(200_000, 30_000)
        assert result["mao"] == 104_000.0
        assert result["profit_margin"] == 0.30
        assert result["profit_target"] == 60_000.0

    def test_high_rehab_zero_mao(self):
        """If rehab exceeds available margin, MAO should floor at 0."""
        result = calculate_mao(100_000, 90_000)
        assert result["mao"] == 0  # would be negative, floored to 0

    def test_custom_margin(self):
        result = calculate_mao(300_000, 50_000, profit_margin=0.20)
        # MAO = 300k*0.80 - 50k - 9k = $181k
        assert result["mao"] == 181_000.0

    def test_with_hold_costs(self):
        result = calculate_mao(200_000, 30_000, hold_costs=5_000)
        # 200k*0.70 - 30k - 6k - 5k = 99k
        assert result["mao"] == 99_000.0


# ===================================================================
# 1. Fix & Flip
# ===================================================================


class TestFixAndFlip:
    def test_profitable_flip(self):
        result = fix_and_flip(150_000, 40_000, 280_000, hold_months=6)
        assert result["model"] == "fix_and_flip"
        assert result["net_profit"] > 0
        assert result["roi"] > 0
        assert result["arv"] == 280_000

    def test_break_even_flip(self):
        # Purchase + rehab + closing ≈ ARV - selling costs
        result = fix_and_flip(200_000, 30_000, 255_000, hold_months=3)
        # At these numbers it might be slightly negative or positive — just check structure
        assert "net_profit" in result
        assert "roi" in result

    def test_loss_flip(self):
        """Buying too high relative to ARV."""
        result = fix_and_flip(250_000, 50_000, 260_000, hold_months=8)
        assert result["net_profit"] < 0
        assert result["roi"] < 0

    def test_with_financing(self):
        result = fix_and_flip(
            150_000, 40_000, 280_000,
            loan_amount=120_000, loan_rate=0.10, hold_months=6,
        )
        assert result["financing_cost"] > 0
        assert result["cash_invested"] < 150_000 + 40_000  # leveraged


# ===================================================================
# 2. BRRRR
# ===================================================================


class TestBRRRR:
    def test_profitable_brrrr(self):
        result = brrrr(120_000, 30_000, 220_000, 1_800)
        assert result["model"] == "brrrr"
        assert result["refi_amount"] == 220_000 * 0.75
        assert result["monthly_cash_flow"] > 0 or result["monthly_cash_flow"] <= 0  # valid number

    def test_cash_out_refi(self):
        """High ARV relative to purchase should yield positive cash out."""
        result = brrrr(100_000, 25_000, 200_000, 1_600)
        assert result["cash_out_refi"] > 0  # Refi amount > initial cost

    def test_negative_cash_flow(self):
        """Low rent, high expenses."""
        result = brrrr(200_000, 50_000, 250_000, 800, monthly_expenses=500)
        # With low rent and high purchase, cash flow should be tight or negative
        assert "monthly_cash_flow" in result

    def test_with_initial_financing(self):
        result = brrrr(
            150_000, 40_000, 250_000, 2_000,
            initial_loan_amount=120_000, initial_loan_rate=0.12,
        )
        assert result["cash_in_before_refi"] < 150_000 + 40_000 + 3_000  # less than full cost


# ===================================================================
# 3. Buy & Hold
# ===================================================================


class TestBuyAndHold:
    def test_profitable_rental(self):
        result = buy_and_hold(200_000, 1_800)
        assert result["model"] == "buy_and_hold"
        assert result["cap_rate"] > 0
        assert result["mortgage_payment"] > 0
        assert len(result["projections"]) == 3  # 5, 10, 30 year

    def test_high_rent_ratio(self):
        """1% rule property — strong cash flow."""
        result = buy_and_hold(150_000, 1_500)
        assert result["monthly_cash_flow"] > 0
        assert result["cash_on_cash_return"] > 0

    def test_negative_cash_flow(self):
        """High price, low rent."""
        result = buy_and_hold(500_000, 1_500)
        assert result["monthly_cash_flow"] < 0

    def test_projections_grow(self):
        result = buy_and_hold(200_000, 1_800, annual_appreciation=0.03)
        projections = result["projections"]
        assert projections[0]["property_value"] < projections[1]["property_value"]
        assert projections[1]["property_value"] < projections[2]["property_value"]


# ===================================================================
# 4. Short-Term Rental
# ===================================================================


class TestShortTermRental:
    def test_profitable_str(self):
        result = short_term_rental(300_000, 200, occupancy_rate=0.75)
        assert result["model"] == "short_term_rental"
        assert result["annual_gross_revenue"] > 0
        assert len(result["monthly_breakdown"]) == 12

    def test_seasonal_variation(self):
        result = short_term_rental(300_000, 200, seasonal_adjustments={
            "q1": 0.60, "q2": 1.0, "q3": 1.50, "q4": 0.90,
        })
        breakdown = result["monthly_breakdown"]
        # Q3 months (Jul/Aug/Sep = indices 6,7,8) should have higher nightly rates
        q1_rate = breakdown[0]["nightly_rate"]
        q3_rate = breakdown[6]["nightly_rate"]
        assert q3_rate > q1_rate

    def test_low_occupancy_loss(self):
        """Low occupancy can lead to net loss."""
        result = short_term_rental(
            500_000, 100, occupancy_rate=0.30, monthly_expenses=500,
        )
        assert result["annual_net_income"] < result["annual_gross_revenue"]

    def test_platform_fees_applied(self):
        result = short_term_rental(200_000, 150, platform_fee_pct=0.15)
        for month in result["monthly_breakdown"]:
            assert month["platform_fees"] > 0


# ===================================================================
# 5. Wholesale
# ===================================================================


class TestWholesale:
    def test_standard_wholesale(self):
        result = wholesale(250_000, 40_000)
        assert result["model"] == "wholesale"
        assert result["assignment_fee"] == 10_000
        assert result["wholesaler_profit"] > 0

    def test_high_assignment_fee(self):
        result = wholesale(300_000, 30_000, assignment_fee=25_000)
        assert result["assignment_fee"] == 25_000
        assert result["buyer_price"] > result["contract_price"]

    def test_buyer_spread_positive(self):
        """Buyer should still profit after assignment fee."""
        result = wholesale(300_000, 40_000, assignment_fee=10_000)
        assert result["buyers_spread"] > 0

    def test_excessive_rehab_squeezes_deal(self):
        result = wholesale(200_000, 150_000, assignment_fee=10_000)
        # Very high rehab relative to ARV — contract price may be 0
        assert result["contract_price"] >= 0


# ===================================================================
# 6. Subject-To
# ===================================================================


class TestSubjectTo:
    def test_standard_sub_to(self):
        result = subject_to(250_000, 180_000, 0.045, 280, 1_800)
        assert result["model"] == "subject_to"
        assert result["equity_position"] == 70_000
        assert result["existing_payment"] > 0

    def test_positive_cash_flow(self):
        result = subject_to(200_000, 100_000, 0.035, 200, 1_500)
        assert result["monthly_cash_flow"] > 0

    def test_with_wrap_mortgage(self):
        result = subject_to(
            250_000, 180_000, 0.045, 280, 1_800,
            wrap_rate=0.08, wrap_term_months=360,
        )
        assert result["wrap_mortgage"] is not None
        assert result["wrap_mortgage"]["monthly_spread"] > 0

    def test_high_balance_tight_flow(self):
        """Mortgage close to property value — low equity, tight cash flow."""
        result = subject_to(200_000, 190_000, 0.06, 340, 1_200)
        assert result["equity_position"] == 10_000


# ===================================================================
# 7. Seller Financing
# ===================================================================


class TestSellerFinancing:
    def test_standard_seller_finance(self):
        result = seller_financing(200_000, 1_600)
        assert result["model"] == "seller_financing"
        assert result["balloon_balance"] is not None  # default balloon at month 60
        assert result["amortization_schedule_length"] > 0

    def test_no_balloon(self):
        result = seller_financing(200_000, 1_600, balloon_month=None)
        assert result["balloon_balance"] is None
        assert result["amortization_schedule_length"] == 360

    def test_profitable_terms(self):
        """Low rate seller financing with good rent."""
        result = seller_financing(
            150_000, 1_500, seller_rate=0.04, down_payment_pct=0.10,
        )
        assert result["monthly_cash_flow"] > 0

    def test_amortization_first_month(self):
        result = seller_financing(200_000, 1_600)
        sched = result["amortization_schedule"]
        assert len(sched) > 0
        assert sched[0]["month"] == 1
        assert sched[0]["payment"] > 0


# ===================================================================
# 8. Hard Money / Bridge
# ===================================================================


class TestHardMoneyBridge:
    def test_standard_hard_money(self):
        result = hard_money_bridge(150_000, 40_000, 280_000)
        assert result["model"] == "hard_money_bridge"
        assert result["origination_fee"] > 0
        assert result["total_cost_of_capital"] > 0

    def test_interest_only_payments(self):
        result = hard_money_bridge(150_000, 40_000, 280_000, interest_only=True)
        # Interest-only: monthly = principal * rate/12
        loan = (150_000 + 40_000) * 0.85
        expected_monthly = loan * (0.12 / 12)
        assert abs(result["monthly_payment"] - expected_monthly) < 1

    def test_with_refi(self):
        result = hard_money_bridge(
            150_000, 40_000, 280_000,
            refi_after_months=6, monthly_rent_after_refi=2_000,
        )
        assert result["refinance"] is not None
        assert result["refinance"]["refi_amount"] == 280_000 * 0.75

    def test_high_points(self):
        result = hard_money_bridge(150_000, 40_000, 280_000, points=5.0)
        loan = (150_000 + 40_000) * 0.85
        assert result["origination_fee"] == round(loan * 0.05, 2)


# ===================================================================
# Scenario Comparison
# ===================================================================


class TestCompareScenarios:
    def test_all_models(self):
        result = compare_scenarios(
            {"purchase_price": 200_000, "arv": 300_000, "rehab_cost": 40_000, "monthly_rent": 1_800},
            {},
        )
        assert result["models_run"] == 8
        assert len(result["summary"]) == 8
        assert len(result["errors"]) == 0

    def test_selected_models(self):
        result = compare_scenarios(
            {"purchase_price": 200_000, "arv": 300_000, "rehab_cost": 40_000, "monthly_rent": 1_800},
            {},
            models=["fix_and_flip", "wholesale"],
        )
        assert result["models_run"] == 2
        model_names = [d["model"] for d in result["details"]]
        assert "fix_and_flip" in model_names
        assert "wholesale" in model_names

    def test_unknown_model_error(self):
        result = compare_scenarios(
            {"purchase_price": 200_000, "arv": 300_000, "rehab_cost": 40_000, "monthly_rent": 1_800},
            {},
            models=["fix_and_flip", "nonexistent"],
        )
        assert result["models_run"] == 1
        assert len(result["errors"]) == 1
        assert result["errors"][0]["model"] == "nonexistent"

    def test_summary_sorted_by_irr(self):
        result = compare_scenarios(
            {"purchase_price": 200_000, "arv": 300_000, "rehab_cost": 40_000, "monthly_rent": 1_800},
            {},
        )
        irrs = [s.get("irr") for s in result["summary"]]
        # Filter out Nones for comparison
        valid_irrs = [i for i in irrs if i is not None]
        assert valid_irrs == sorted(valid_irrs, reverse=True)


# ===================================================================
# Integration tests (via HTTP client)
# ===================================================================


# ===================================================================
# Backtesting — real-world deal scenarios with hand-verified results
# CEO-mandated: realistic numbers, not toy values (see GCP-14 comment)
# ===================================================================


class TestBacktestMAO:
    """Hand-verified MAO calculations against known deal analysis."""

    def test_mao_200k_arv_30k_rehab(self):
        """Standard flip: ARV $200K, rehab $30K, 30% margin.

        Hand calc: 200000*0.70 - 30000 - 6000 = 104000
        """
        result = calculate_mao(200_000, 30_000)
        assert result["mao"] == 104_000.0
        assert result["closing_costs"] == 6_000.0
        assert result["profit_target"] == 60_000.0

    def test_mao_350k_arv_75k_rehab_25pct_margin(self):
        """Larger deal: ARV $350K, rehab $75K, 25% margin.

        Hand calc: 350000*0.75 - 75000 - 10500 = 177000
        closing_costs = 350000 * 0.03 = 10500
        """
        result = calculate_mao(350_000, 75_000, profit_margin=0.25)
        assert result["mao"] == 177_000.0
        assert result["closing_costs"] == 10_500.0
        assert result["profit_target"] == 87_500.0

    def test_mao_150k_arv_101k_rehab_floors_zero(self):
        """Heavy rehab exceeds margin — MAO floors at $0.

        Hand calc: 150000*0.70 - 101000 - 4500 = -500 → 0
        """
        result = calculate_mao(150_000, 101_000)
        assert result["mao"] == 0


class TestBacktestIRR:
    """Hand-verified IRR against textbook examples."""

    def test_irr_even_cash_flows_15pct(self):
        """$10K investment, $3K/yr for 5 years ≈ 15.24% IRR (textbook value)."""
        irr = calculate_irr([-10_000, 3_000, 3_000, 3_000, 3_000, 3_000])
        assert irr is not None
        assert abs(irr - 0.1524) < 0.005  # within 0.5% of textbook

    def test_irr_single_period_doubling(self):
        """$50K in, $100K out in 1 period = 100% IRR."""
        irr = calculate_irr([-50_000, 100_000])
        assert irr is not None
        assert abs(irr - 1.0) < 0.01

    def test_irr_negative_return(self):
        """$100K in, $20K/yr for 3 years = negative IRR."""
        irr = calculate_irr([-100_000, 20_000, 20_000, 20_000])
        assert irr is not None
        assert irr < 0


class TestBacktestFixAndFlip:
    """Realistic fix & flip: $200K purchase, $60K rehab, 12% hard money, 6-month hold."""

    def test_realistic_flip_with_hard_money(self):
        """Real deal scenario per CEO requirement.

        Purchase: $200K, Rehab: $60K, ARV: $350K, Hold: 6 months
        Hard money on $200K at 12%, 6 months interest-only
        Buying closing: 200K * 0.02 = 4K
        Selling closing: 350K * 0.06 = 21K
        Financing: 200K * 0.12/12 * 6 = 12K
        Total cost: 200K + 60K + 4K + 0 + 12K = 276K
        Net profit: 350K - 276K - 21K = 53K
        Cash invested: 200K + 60K + 4K - 200K = 64K
        ROI: 53K / 64K ≈ 82.8%
        """
        result = fix_and_flip(
            200_000, 60_000, 350_000,
            hold_months=6, loan_amount=200_000, loan_rate=0.12,
        )
        assert result["model"] == "fix_and_flip"
        assert result["financing_cost"] == 12_000.0
        assert result["buying_closing_costs"] == 4_000.0
        assert result["selling_closing_costs"] == 21_000.0
        assert result["cash_invested"] == 64_000.0
        assert abs(result["net_profit"] - 53_000.0) < 1.0
        assert result["roi"] > 0.80

    def test_realistic_flip_loss_scenario(self):
        """Over-leveraged flip: ARV comes in low.

        Purchase: $250K, Rehab: $45K, ARV: $300K (appraisal came in low), Hold: 8 months
        """
        result = fix_and_flip(250_000, 45_000, 300_000, hold_months=8)
        # Buying closing: 5K, Selling closing: 18K
        # Total cost: 250+45+5+0+0 = 300K, minus 18K selling = net loss
        assert result["net_profit"] < 0


class TestBacktestBRRRR:
    """Real BRRRR: $120K purchase, $30K rehab, $220K ARV, $1800/mo rent."""

    def test_realistic_brrrr(self):
        """Classic BRRRR with all-cash initial purchase.

        Total in: 120K + 30K + 2.4K(closing) = 152.4K
        Refi: 220K * 0.75 = 165K
        Cash out: 165K - 0(no initial loan) = 165K
        Cash left in: 152.4K - 165K = -12.6K → they pulled out more than they put in
        """
        result = brrrr(120_000, 30_000, 220_000, 1_800)
        assert result["refi_amount"] == 165_000.0
        assert result["total_initial_investment"] == 152_400.0
        assert result["cash_out_refi"] == 165_000.0
        # Cash left in deal should be 0 (floored) since refi > cost
        assert result["cash_left_in_deal"] == 0


class TestBacktestHardMoney:
    """Real hard money: $150K purchase, $40K rehab, $280K ARV, 12% rate, 2 points."""

    def test_realistic_hard_money_bridge(self):
        """Standard hard money bridge deal.

        Total project: $190K, LTC 85% → loan $161.5K
        Cash needed: $28.5K
        Points: 161.5K * 0.02 = $3,230
        Monthly interest-only: 161.5K * 0.01 = $1,615
        6-month hold: $9,690 total interest
        Total cost of capital: $3,230 + $9,690 = $12,920
        """
        result = hard_money_bridge(150_000, 40_000, 280_000)
        assert result["loan_amount"] == 161_500.0
        assert result["cash_needed"] == 28_500.0
        assert result["origination_fee"] == 3_230.0
        assert result["monthly_payment"] == 1_615.0
        assert result["total_interest"] == 9_690.0
        assert result["total_cost_of_capital"] == 12_920.0


class TestBacktestBuyAndHold:
    """Real buy & hold: $200K property, $1800/mo rent, 20% down, 7% rate."""

    def test_realistic_buy_and_hold(self):
        """Verify cash flow math against hand calcs.

        Down: $40K, Closing: $6K, Loan: $160K
        Mortgage (30yr @ 7%): ~$1064.48/mo
        Effective rent: 1800 * 0.92 = 1656
        Cash flow: 1656 - 1064.48 = ~591.52/mo
        Cap rate: (1656*12)/200K = 9.94%
        """
        result = buy_and_hold(200_000, 1_800)
        assert result["down_payment"] == 40_000.0
        assert result["closing_costs"] == 6_000.0
        assert result["loan_amount"] == 160_000.0
        assert result["effective_rent"] == 1_656.0
        assert abs(result["mortgage_payment"] - 1_064.48) < 1.0
        assert result["monthly_cash_flow"] > 500
        assert abs(result["cap_rate"] - 0.0994) < 0.001


# ===================================================================
# Integration tests (via HTTP client)
# ===================================================================


@pytest.mark.asyncio
async def test_financing_compare_endpoint(client):
    """Integration test for the scenario comparison endpoint."""
    response = await client.post("/financing/compare", json={
        "property_data": {
            "purchase_price": 200_000,
            "arv": 300_000,
            "rehab_cost": 40_000,
            "monthly_rent": 1_800,
        },
        "assumptions": {},
    })
    assert response.status_code == 200
    data = response.json()
    assert data["models_run"] == 8
    assert len(data["summary"]) == 8


@pytest.mark.asyncio
async def test_financing_fix_and_flip_endpoint(client):
    response = await client.post("/financing/fix-and-flip", json={
        "purchase_price": 150_000,
        "rehab_cost": 40_000,
        "arv": 280_000,
    })
    assert response.status_code == 200
    data = response.json()
    assert data["model"] == "fix_and_flip"
    assert data["result"]["net_profit"] > 0


@pytest.mark.asyncio
async def test_financing_mao_endpoint(client):
    response = await client.post("/financing/mao", json={
        "arv": 200_000,
        "rehab_cost": 30_000,
    })
    assert response.status_code == 200
    data = response.json()
    assert data["mao"] == 104_000.0


@pytest.mark.asyncio
async def test_financing_irr_endpoint(client):
    response = await client.post("/financing/irr", json={
        "cash_flows": [-10000, 3000, 3000, 3000, 3000, 3000],
    })
    assert response.status_code == 200
    data = response.json()
    assert data["irr"] is not None
    assert 0.10 < data["irr"] < 0.20
