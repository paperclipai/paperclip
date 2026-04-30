# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaSkill"]


class BetaSkill(BaseModel):
    """A skill that was loaded in a container (response model)."""

    skill_id: str
    """Skill ID"""

    type: Literal["anthropic", "custom"]
    """Type of skill - either 'anthropic' (built-in) or 'custom' (user-defined)"""

    version: str
    """Skill version or 'latest' for most recent version"""
