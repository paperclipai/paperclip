# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from typing_extensions import Literal

from ..._models import BaseModel
from .beta_managed_agents_model import BetaManagedAgentsModel

__all__ = ["BetaManagedAgentsModelConfig"]


class BetaManagedAgentsModelConfig(BaseModel):
    """Model identifier and configuration."""

    id: BetaManagedAgentsModel
    """
    The model that will power your agent.\n\nSee
    [models](https://docs.anthropic.com/en/docs/models-overview) for additional
    details and options.
    """

    speed: Optional[Literal["standard", "fast"]] = None
    """Inference speed mode.

    `fast` provides significantly faster output token generation at premium pricing.
    Not all models support `fast`; invalid combinations are rejected at create time.
    """
