# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union
from typing_extensions import Literal, Required, TypeAlias, TypedDict

from .beta_thinking_turns_param import BetaThinkingTurnsParam
from .beta_all_thinking_turns_param import BetaAllThinkingTurnsParam

__all__ = ["BetaClearThinking20251015EditParam", "Keep"]

Keep: TypeAlias = Union[BetaThinkingTurnsParam, BetaAllThinkingTurnsParam, Literal["all"]]


class BetaClearThinking20251015EditParam(TypedDict, total=False):
    type: Required[Literal["clear_thinking_20251015"]]

    keep: Keep
    """Number of most recent assistant turns to keep thinking blocks for.

    Older turns will have their thinking blocks removed.
    """
