# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Iterable, Optional
from typing_extensions import TypedDict

from .beta_skill_params import BetaSkillParams

__all__ = ["BetaContainerParams"]


class BetaContainerParams(TypedDict, total=False):
    """Container parameters with skills to be loaded."""

    id: Optional[str]
    """Container id"""

    skills: Optional[Iterable[BetaSkillParams]]
    """List of skills to load in the container"""
