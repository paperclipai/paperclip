# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union
from typing_extensions import TypeAlias

from .beta_tool_choice_any_param import BetaToolChoiceAnyParam
from .beta_tool_choice_auto_param import BetaToolChoiceAutoParam
from .beta_tool_choice_none_param import BetaToolChoiceNoneParam
from .beta_tool_choice_tool_param import BetaToolChoiceToolParam

__all__ = ["BetaToolChoiceParam"]

BetaToolChoiceParam: TypeAlias = Union[
    BetaToolChoiceAutoParam, BetaToolChoiceAnyParam, BetaToolChoiceToolParam, BetaToolChoiceNoneParam
]
