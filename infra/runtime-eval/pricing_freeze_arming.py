"""Quote-freeze arming mechanism — SAG-6327 Phase 5 (SAG-6345).

BUILD-ONLY. This module MUST NOT autonomously arm a client-facing quote freeze.
Per SAG-6302's binding CEO operating condition, the freeze has direct revenue
impact, so *arming* is not an autonomous action: it requires explicit
human/board sign-off. This module therefore does two separable things:

  1. `evaluate_arming_readiness()` — a pure, side-effect-free evaluation of
     whether the arming preconditions are met, and (if so) which record_keys
     are in the proposed freeze scope. This is safe to call on every nightly
     run for reporting; it takes no action.

  2. `arm_freeze()` — the only function that produces an armed-freeze record,
     and it structurally cannot be triggered autonomously: it *requires* a
     valid `ArmingAuthorization` carrying an explicit human/board sign-off. No
     caller in this codebase (the nightly runner included) constructs an
     `ArmingAuthorization`; only a human/board sign-off flow does. Absent that
     token, `arm_freeze()` raises rather than arming.

Binding preconditions (SAG-6302 "quote-freeze arming"):

  * No arming during the 30-day observe-only warm-up (Phase 4). Warm-up is
    evaluated with the runner's own `is_warm_up()` so the two phases can never
    disagree on the window.
  * Arms only AFTER warm-up completes AND at least one clean baseline median
    exists per (SKU, bucket) — here, per `record_key`
    (`product_estimate_group|bucket_code|territory`, the runner's grain).

When armed (behavior the sign-off flow authorizes — enforcement wiring into the
quoting system is a downstream phase, out of scope here):

  * freeze is scoped to affected client-facing lines only — CRITICAL alerts
    only, and only where a clean baseline median exists to fall back to;
  * existing quotes are honored (the freeze gates new quotes, not booked ones);
  * unfreeze requires a refreshed record + paired-write log + Auditor/Director
    sign-off, a 2-business-day remediation SLA, then CEO escalation.

The baseline-median source is injected via the `BaselineMedianProvider`
contract, following the epic's established loud-fail dependency-injection
pattern (see pricing_feeds.py Phase 0): the `NotImplemented*` provider raises
rather than silently reporting "no baselines," so a mis-wired caller cannot
accidentally look un-armable (or, worse, mint a spurious clean baseline).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from pricing_staleness_runner import (
    WARM_UP_DURATION_DAYS,
    WARM_UP_START_DATE,
    is_warm_up,
)

# Sign-off authorities that may authorize arming. Deliberately excludes every
# agent/automation identity: only a human or the board can arm.
VALID_ARMING_AUTHORITIES = frozenset({"human", "board"})

# Documented unfreeze contract (SAG-6302). Carried on the armed record so the
# sign-off/unfreeze flow reads it from one place rather than re-deriving it.
UNFREEZE_REQUIREMENTS = (
    "refreshed rate record",
    "paired-write log entry",
    "Auditor/Director sign-off",
    "2-business-day remediation SLA, then CEO escalation",
)


class ArmingError(RuntimeError):
    """Base class for all freeze-arming refusals."""


class ArmingBlockedError(ArmingError):
    """Raised when arming is attempted while a hard precondition is unmet
    (still in warm-up, no clean baseline, or empty freeze scope)."""


class ArmingNotAuthorizedError(ArmingError):
    """Raised when arming is attempted without a valid explicit human/board
    sign-off. This is the guard that makes auto-arming structurally impossible."""


class BaselineMedianUnavailableError(RuntimeError):
    """Raised when the baseline-median source is queried before it is wired.

    Callers must handle this by reporting "not yet evaluable," never by
    treating it as "no clean baselines exist."
    """


@dataclass(frozen=True)
class BaselineMedian:
    """One materialized trailing-3-month baseline median for a record_key.

    `is_clean` is True when the median is usable as a freeze reference: it was
    computed from a sufficient sample and is not itself contaminated by an
    unresolved CRITICAL anomaly on the same record. The provider owns that
    determination (it has the history); this module only consumes the flag.
    """

    record_key: str
    field_name: str
    median_value: Decimal
    sample_size: int
    computed_at: datetime
    is_clean: bool = True


class BaselineMedianProvider:
    """Contract for the clean-baseline-median source (materialized during the
    Phase 4 warm-up). Abstract; implementations below."""

    def get_clean_baseline_medians(self, as_of: datetime) -> list[BaselineMedian]:
        raise NotImplementedError


class NotImplementedBaselineMedianProvider(BaselineMedianProvider):
    """Loud-fail default: raises rather than silently reporting no baselines."""

    def get_clean_baseline_medians(self, as_of: datetime) -> list[BaselineMedian]:
        raise BaselineMedianUnavailableError(
            "No baseline-median source wired (Phase 4 warm-up materialization "
            "not yet connected); refusing to report freeze-arming readiness "
            "against an empty baseline set."
        )


@dataclass
class InMemoryBaselineMedianProvider(BaselineMedianProvider):
    """In-memory provider for development/tests."""

    medians: list[BaselineMedian] = field(default_factory=list)

    def get_clean_baseline_medians(self, as_of: datetime) -> list[BaselineMedian]:
        return [m for m in self.medians if m.is_clean and m.computed_at <= as_of]


@dataclass(frozen=True)
class ArmingReadiness:
    """Pure evaluation of whether the freeze may be armed, and over what scope.

    This is a *report*, not an action. `eligible_to_arm` being True does NOT
    mean the freeze is or will be armed — it means a human/board sign-off is
    now permitted to arm it via `arm_freeze()`.
    """

    as_of: datetime
    warm_up_complete: bool
    warm_up_ends_on: date
    clean_baseline_keys: frozenset[str]
    outstanding_critical_keys: frozenset[str]
    armable_scope: tuple[str, ...]
    blocked_critical_keys: tuple[str, ...]
    eligible_to_arm: bool
    blocking_reasons: tuple[str, ...]
    requires_signoff: bool = True


def warm_up_end_date(warm_up_start: date = WARM_UP_START_DATE) -> date:
    """First calendar date on which warm-up is over (arming may be considered)."""
    from datetime import timedelta

    return warm_up_start + timedelta(days=WARM_UP_DURATION_DAYS)


def evaluate_arming_readiness(
    *,
    as_of: datetime,
    baseline_provider: BaselineMedianProvider,
    outstanding_critical_keys: set[str] | frozenset[str],
    warm_up_start: date = WARM_UP_START_DATE,
) -> ArmingReadiness:
    """Evaluate arming preconditions. Pure/read-only — takes no action.

    `outstanding_critical_keys` are the record_keys currently carrying a
    CRITICAL staleness alert (the client-facing lines a freeze would scope to).
    The freeze scope is those keys intersected with keys that have a clean
    baseline median to fall back to; a CRITICAL key without a clean baseline is
    reported as blocked (unsafe to freeze) rather than silently dropped.
    """
    warm_up_complete = not is_warm_up(as_of, warm_up_start)

    clean_keys = frozenset(
        m.record_key for m in baseline_provider.get_clean_baseline_medians(as_of)
    )
    critical_keys = frozenset(outstanding_critical_keys)

    armable = tuple(sorted(critical_keys & clean_keys))
    blocked = tuple(sorted(critical_keys - clean_keys))

    reasons: list[str] = []
    if not warm_up_complete:
        reasons.append(
            f"in 30-day observe-only warm-up (ends {warm_up_end_date(warm_up_start).isoformat()})"
        )
    if not clean_keys:
        reasons.append("no clean baseline median exists for any (SKU, bucket) yet")

    eligible = warm_up_complete and len(clean_keys) >= 1

    return ArmingReadiness(
        as_of=as_of,
        warm_up_complete=warm_up_complete,
        warm_up_ends_on=warm_up_end_date(warm_up_start),
        clean_baseline_keys=clean_keys,
        outstanding_critical_keys=critical_keys,
        armable_scope=armable,
        blocked_critical_keys=blocked,
        eligible_to_arm=eligible,
        blocking_reasons=tuple(reasons),
    )


@dataclass(frozen=True)
class FreezeArmingProposal:
    """A freeze that *could* be armed, pending explicit human/board sign-off.

    Produced by `build_freeze_proposal()` only when preconditions are met and
    there is a non-empty scope. It is the artifact a human/board reviews before
    authorizing `arm_freeze()`. Constructing a proposal arms nothing.
    """

    as_of: datetime
    scope: tuple[str, ...]
    baseline_refs: tuple[str, ...]
    rationale: str
    requires_signoff: bool = True


def build_freeze_proposal(readiness: ArmingReadiness) -> Optional[FreezeArmingProposal]:
    """Turn a readiness evaluation into a sign-off-ready proposal, or None.

    Returns None when arming is not eligible or there is nothing CRITICAL to
    freeze (an empty scope) — i.e. when there is no proposal to put in front of
    a human/board.
    """
    if not readiness.eligible_to_arm or not readiness.armable_scope:
        return None
    return FreezeArmingProposal(
        as_of=readiness.as_of,
        scope=readiness.armable_scope,
        baseline_refs=tuple(sorted(readiness.clean_baseline_keys & set(readiness.armable_scope))),
        rationale=(
            f"{len(readiness.armable_scope)} client-facing line(s) carry a CRITICAL "
            "staleness alert and have a clean baseline median to fall back to; "
            "warm-up is complete. Arming requires explicit human/board sign-off."
        ),
    )


@dataclass(frozen=True)
class ArmingAuthorization:
    """Explicit human/board sign-off authorizing a specific arm action.

    The presence of a validated instance of this class is the ONLY thing that
    lets `arm_freeze()` proceed. Nothing in the automated pipeline constructs
    one; it is minted by a human/board sign-off flow.
    """

    authorized_by: str
    authority: str  # must be one of VALID_ARMING_AUTHORITIES
    reference: str  # audit pointer: sign-off comment / issue / board minute id
    authorized_at: datetime

    def validate(self) -> None:
        if self.authority not in VALID_ARMING_AUTHORITIES:
            raise ArmingNotAuthorizedError(
                f"arming authority {self.authority!r} is not a human/board sign-off "
                f"(must be one of {sorted(VALID_ARMING_AUTHORITIES)}); refusing to arm."
            )
        if not self.authorized_by.strip():
            raise ArmingNotAuthorizedError("arming sign-off is missing an authorizer identity.")
        if not self.reference.strip():
            raise ArmingNotAuthorizedError(
                "arming sign-off is missing an audit reference (comment/issue/minute id)."
            )


@dataclass(frozen=True)
class ArmedFreeze:
    """Record of an armed freeze. Reachable only via a signed `arm_freeze()`."""

    scope: tuple[str, ...]
    armed_at: datetime
    authorization: ArmingAuthorization
    existing_quotes_honored: bool = True
    unfreeze_requirements: tuple[str, ...] = UNFREEZE_REQUIREMENTS


def arm_freeze(
    proposal: Optional[FreezeArmingProposal],
    authorization: Optional[ArmingAuthorization],
    *,
    as_of: datetime,
    warm_up_start: date = WARM_UP_START_DATE,
) -> ArmedFreeze:
    """Arm the freeze for `proposal.scope`. NEVER auto-arms.

    Refuses unless BOTH hold:
      * a valid, non-empty proposal whose preconditions still hold at `as_of`
        (defense-in-depth re-check that warm-up is over), and
      * an explicit, valid human/board `ArmingAuthorization`.

    Raises `ArmingBlockedError` (preconditions) or `ArmingNotAuthorizedError`
    (no/invalid sign-off) otherwise. There is no code path that arms without a
    caller-supplied `ArmingAuthorization`.
    """
    # Defense in depth: re-assert the warm-up gate at the moment of arming,
    # independent of whatever readiness evaluation produced the proposal.
    if is_warm_up(as_of, warm_up_start):
        raise ArmingBlockedError(
            "refusing to arm during the 30-day observe-only warm-up "
            f"(ends {warm_up_end_date(warm_up_start).isoformat()})."
        )
    if proposal is None or not proposal.scope:
        raise ArmingBlockedError(
            "no armable freeze proposal (preconditions unmet or empty scope); nothing to arm."
        )
    if authorization is None:
        raise ArmingNotAuthorizedError(
            "quote-freeze arming requires explicit human/board sign-off; "
            "refusing to arm autonomously (SAG-6302 binding operating condition)."
        )
    authorization.validate()

    return ArmedFreeze(
        scope=proposal.scope,
        armed_at=as_of,
        authorization=authorization,
    )


def format_arming_readiness(readiness: ArmingReadiness) -> str:
    """One-line-ish, report-only rendering for the nightly digest. No action."""
    if readiness.eligible_to_arm and readiness.armable_scope:
        head = (
            f"ELIGIBLE — {len(readiness.armable_scope)} line(s) proposable for freeze, "
            "AWAITING explicit human/board sign-off (not armed)"
        )
    elif readiness.eligible_to_arm:
        head = "eligible, but no CRITICAL client-facing line to freeze right now (not armed)"
    else:
        head = "NOT eligible to arm: " + "; ".join(readiness.blocking_reasons)
    return f"Quote-freeze arming — {readiness.as_of.date().isoformat()}: {head}"
