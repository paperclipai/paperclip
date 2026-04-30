# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union
from typing_extensions import TypeAlias

from .beta_thinking_config_enabled_param import BetaThinkingConfigEnabledParam
from .beta_thinking_config_adaptive_param import BetaThinkingConfigAdaptiveParam
from .beta_thinking_config_disabled_param import BetaThinkingConfigDisabledParam

__all__ = ["BetaThinkingConfigParam"]

BetaThinkingConfigParam: TypeAlias = Union[
    BetaThinkingConfigEnabledParam, BetaThinkingConfigDisabledParam, BetaThinkingConfigAdaptiveParam
]
