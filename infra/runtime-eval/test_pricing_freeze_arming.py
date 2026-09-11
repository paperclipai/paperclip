"""Tests for the SAG-6345 Phase 5 quote-freeze arming mechanism.

These lock the binding constraints: no arming during warm-up, arming needs a
clean baseline median, freeze scope is CRITICAL-and-clean-baseline only, and —
the core of the ticket — arming is impossible without an explicit human/board
sign-off. The mechanism is built and fully exercised, but never auto-arms.
"""

from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from pricing_staleness_runner import WARM_UP_DURATION_DAYS, WARM_UP_START_DATE
from pricing_freeze_arming import (
    ArmingAuthorization,
    ArmingBlockedError,
    ArmingNotAuthorizedError,
    BaselineMedian,
    BaselineMedianUnavailableError,
    InMemoryBaselineMedianProvider,
    NotImplementedBaselineMedianProvider,
    UNFREEZE_REQUIREMENTS,
    arm_freeze,
    build_freeze_proposal,
    evaluate_arming_readiness,
    format_arming_readiness,
    warm_up_end_date,
)

UTC = timezone.utc

# A datetime safely inside the warm-up window and one safely after it.
DURING_WARM_UP = datetime.combine(WARM_UP_START_DATE, datetime.min.time(), tzinfo=UTC) + timedelta(days=5)
POST_WARM_UP = datetime.combine(WARM_UP_START_DATE, datetime.min.time(), tzinfo=UTC) + timedelta(
    days=WARM_UP_DURATION_DAYS + 1
)


def _clean_median(record_key, computed_at=None, is_clean=True):
    return BaselineMedian(
        record_key=record_key,
        field_name="fee_per_sqft",
        median_value=Decimal("12.50"),
        sample_size=6,
        computed_at=computed_at or (POST_WARM_UP - timedelta(days=1)),
        is_clean=is_clean,
    )


def _signoff(as_of=POST_WARM_UP, authority="human", by="pricing-director", ref="SAG-6345#signoff"):
    return ArmingAuthorization(
        authorized_by=by, authority=authority, reference=ref, authorized_at=as_of
    )


# ---------------------------------------------------------------------------
# Warm-up gate
# ---------------------------------------------------------------------------


class TestWarmUpGate:
    def test_not_eligible_during_warm_up_even_with_clean_baselines(self):
        provider = InMemoryBaselineMedianProvider([_clean_median("FG3|FQ3-A|TX", DURING_WARM_UP - timedelta(days=1))])
        readiness = evaluate_arming_readiness(
            as_of=DURING_WARM_UP,
            baseline_provider=provider,
            outstanding_critical_keys={"FG3|FQ3-A|TX"},
        )
        assert readiness.warm_up_complete is False
        assert readiness.eligible_to_arm is False
        assert any("warm-up" in r for r in readiness.blocking_reasons)

    def test_warm_up_end_date_is_start_plus_duration(self):
        assert warm_up_end_date() == WARM_UP_START_DATE + timedelta(days=WARM_UP_DURATION_DAYS)

    def test_arm_freeze_refuses_during_warm_up_defense_in_depth(self):
        # Even if handed a non-empty proposal + valid sign-off, arming during
        # warm-up is refused by the arm_freeze re-check.
        provider = InMemoryBaselineMedianProvider([_clean_median("FG3|FQ3-A|TX", POST_WARM_UP - timedelta(days=1))])
        readiness = evaluate_arming_readiness(
            as_of=POST_WARM_UP, baseline_provider=provider, outstanding_critical_keys={"FG3|FQ3-A|TX"}
        )
        proposal = build_freeze_proposal(readiness)
        assert proposal is not None
        with pytest.raises(ArmingBlockedError, match="warm-up"):
            arm_freeze(proposal, _signoff(DURING_WARM_UP), as_of=DURING_WARM_UP)


# ---------------------------------------------------------------------------
# Clean-baseline precondition + scope
# ---------------------------------------------------------------------------


class TestBaselinePrecondition:
    def test_not_eligible_post_warm_up_without_any_clean_baseline(self):
        provider = InMemoryBaselineMedianProvider([])  # no baselines materialized
        readiness = evaluate_arming_readiness(
            as_of=POST_WARM_UP, baseline_provider=provider, outstanding_critical_keys={"FG3|FQ3-A|TX"}
        )
        assert readiness.warm_up_complete is True
        assert readiness.eligible_to_arm is False
        assert any("clean baseline" in r for r in readiness.blocking_reasons)

    def test_contaminated_baseline_does_not_count_as_clean(self):
        provider = InMemoryBaselineMedianProvider([_clean_median("FG3|FQ3-A|TX", is_clean=False)])
        readiness = evaluate_arming_readiness(
            as_of=POST_WARM_UP, baseline_provider=provider, outstanding_critical_keys={"FG3|FQ3-A|TX"}
        )
        assert readiness.clean_baseline_keys == frozenset()
        assert readiness.eligible_to_arm is False

    def test_scope_is_critical_intersect_clean_baseline(self):
        provider = InMemoryBaselineMedianProvider(
            [_clean_median("FG3|FQ3-A|TX"), _clean_median("FG3|FQ3-B|TX"), _clean_median("FG3|FQ3-C|TX")]
        )
        readiness = evaluate_arming_readiness(
            as_of=POST_WARM_UP,
            baseline_provider=provider,
            # FQ3-A has a clean baseline (armable); FQ3-Z is critical but has no
            # baseline (blocked); FQ3-B has a baseline but isn't critical (out of scope).
            outstanding_critical_keys={"FG3|FQ3-A|TX", "FG3|FQ3-Z|TX"},
        )
        assert readiness.eligible_to_arm is True
        assert readiness.armable_scope == ("FG3|FQ3-A|TX",)
        assert readiness.blocked_critical_keys == ("FG3|FQ3-Z|TX",)

    def test_no_proposal_during_warm_up_even_with_critical_and_baseline(self):
        # Directly pin the `not eligible_to_arm` branch of build_freeze_proposal.
        provider = InMemoryBaselineMedianProvider(
            [_clean_median("FG3|FQ3-A|TX", DURING_WARM_UP - timedelta(days=1))]
        )
        readiness = evaluate_arming_readiness(
            as_of=DURING_WARM_UP, baseline_provider=provider, outstanding_critical_keys={"FG3|FQ3-A|TX"}
        )
        assert readiness.eligible_to_arm is False
        assert build_freeze_proposal(readiness) is None

    def test_eligible_with_no_critical_lines_yields_no_proposal(self):
        provider = InMemoryBaselineMedianProvider([_clean_median("FG3|FQ3-A|TX")])
        readiness = evaluate_arming_readiness(
            as_of=POST_WARM_UP, baseline_provider=provider, outstanding_critical_keys=set()
        )
        assert readiness.eligible_to_arm is True
        assert readiness.armable_scope == ()
        assert build_freeze_proposal(readiness) is None


# ---------------------------------------------------------------------------
# Loud-fail provider
# ---------------------------------------------------------------------------


class TestLoudFailProvider:
    def test_notimplemented_provider_raises_rather_than_reporting_empty(self):
        with pytest.raises(BaselineMedianUnavailableError):
            evaluate_arming_readiness(
                as_of=POST_WARM_UP,
                baseline_provider=NotImplementedBaselineMedianProvider(),
                outstanding_critical_keys={"FG3|FQ3-A|TX"},
            )


# ---------------------------------------------------------------------------
# The core guard: no autonomous arming
# ---------------------------------------------------------------------------


class TestArmingRequiresSignoff:
    def _eligible_proposal(self):
        provider = InMemoryBaselineMedianProvider([_clean_median("FG3|FQ3-A|TX")])
        readiness = evaluate_arming_readiness(
            as_of=POST_WARM_UP, baseline_provider=provider, outstanding_critical_keys={"FG3|FQ3-A|TX"}
        )
        return build_freeze_proposal(readiness)

    def test_arm_without_authorization_is_refused(self):
        proposal = self._eligible_proposal()
        with pytest.raises(ArmingNotAuthorizedError, match="human/board sign-off"):
            arm_freeze(proposal, None, as_of=POST_WARM_UP)

    def test_arm_with_agent_authority_is_rejected(self):
        proposal = self._eligible_proposal()
        bad = ArmingAuthorization(
            authorized_by="cloud-eng-director", authority="agent", reference="run-123", authorized_at=POST_WARM_UP
        )
        with pytest.raises(ArmingNotAuthorizedError, match="not a human/board"):
            arm_freeze(proposal, bad, as_of=POST_WARM_UP)

    def test_arm_with_blank_authorizer_is_rejected(self):
        proposal = self._eligible_proposal()
        bad = ArmingAuthorization(authorized_by="   ", authority="board", reference="minute-9", authorized_at=POST_WARM_UP)
        with pytest.raises(ArmingNotAuthorizedError, match="authorizer identity"):
            arm_freeze(proposal, bad, as_of=POST_WARM_UP)

    def test_arm_with_missing_reference_is_rejected(self):
        proposal = self._eligible_proposal()
        bad = ArmingAuthorization(authorized_by="pricing-director", authority="human", reference="", authorized_at=POST_WARM_UP)
        with pytest.raises(ArmingNotAuthorizedError, match="audit reference"):
            arm_freeze(proposal, bad, as_of=POST_WARM_UP)

    def test_arm_with_no_proposal_is_blocked(self):
        with pytest.raises(ArmingBlockedError, match="nothing to arm"):
            arm_freeze(None, _signoff(), as_of=POST_WARM_UP)

    def test_happy_path_arms_only_with_valid_human_signoff(self):
        proposal = self._eligible_proposal()
        armed = arm_freeze(proposal, _signoff(authority="human"), as_of=POST_WARM_UP)
        assert armed.scope == ("FG3|FQ3-A|TX",)
        assert armed.existing_quotes_honored is True
        assert armed.unfreeze_requirements == UNFREEZE_REQUIREMENTS
        assert armed.authorization.authority == "human"

    def test_board_authority_also_arms(self):
        proposal = self._eligible_proposal()
        armed = arm_freeze(proposal, _signoff(authority="board", by="local-board", ref="board-minute-42"), as_of=POST_WARM_UP)
        assert armed.authorization.authority == "board"


# ---------------------------------------------------------------------------
# Report rendering (report-only; proves no action is implied)
# ---------------------------------------------------------------------------


class TestReporting:
    def test_report_says_awaiting_signoff_when_eligible(self):
        provider = InMemoryBaselineMedianProvider([_clean_median("FG3|FQ3-A|TX")])
        readiness = evaluate_arming_readiness(
            as_of=POST_WARM_UP, baseline_provider=provider, outstanding_critical_keys={"FG3|FQ3-A|TX"}
        )
        text = format_arming_readiness(readiness)
        assert "AWAITING" in text and "not armed" in text

    def test_report_states_warm_up_block(self):
        provider = InMemoryBaselineMedianProvider([_clean_median("FG3|FQ3-A|TX", DURING_WARM_UP - timedelta(days=1))])
        readiness = evaluate_arming_readiness(
            as_of=DURING_WARM_UP, baseline_provider=provider, outstanding_critical_keys={"FG3|FQ3-A|TX"}
        )
        assert "NOT eligible" in format_arming_readiness(readiness)
