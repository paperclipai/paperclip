# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

from .beta_managed_agents_model_param import BetaManagedAgentsModelParam

__all__ = ["BetaManagedAgentsModelConfigParams"]


class BetaManagedAgentsModelConfigParams(TypedDict, total=False):
    """An object that defines additional configuration control over model use"""

    id: Required[BetaManagedAgentsModelParam]
    """
    The model that will power your agent.\n\nSee
    [models](https://docs.anthropic.com/en/docs/models-overview) for additional
    details and options.
    """

    speed: Optional[Literal["standard", "fast"]]
    """Inference speed mode.

    `fast` provides significantly faster output token generation at premium pricing.
    Not all models support `fast`; invalid combinations are rejected at create time.
    """
