# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaSkillParams"]


class BetaSkillParams(TypedDict, total=False):
    """Specification for a skill to be loaded in a container (request model)."""

    skill_id: Required[str]
    """Skill ID"""

    type: Required[Literal["anthropic", "custom"]]
    """Type of skill - either 'anthropic' (built-in) or 'custom' (user-defined)"""

    version: str
    """Skill version or 'latest' for most recent version"""
