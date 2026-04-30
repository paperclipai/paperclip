# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaManagedAgentsCustomSkillParams"]


class BetaManagedAgentsCustomSkillParams(TypedDict, total=False):
    """A user-created custom skill."""

    skill_id: Required[str]
    """Tagged ID of the custom skill (e.g., "skill_01XJ5...")."""

    type: Required[Literal["custom"]]

    version: Optional[str]
    """Version to pin. Defaults to latest if omitted."""
