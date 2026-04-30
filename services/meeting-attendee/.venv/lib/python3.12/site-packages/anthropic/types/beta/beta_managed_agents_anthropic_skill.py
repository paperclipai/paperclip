# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaManagedAgentsAnthropicSkill"]


class BetaManagedAgentsAnthropicSkill(BaseModel):
    """A resolved Anthropic-managed skill."""

    skill_id: str

    type: Literal["anthropic"]

    version: str
