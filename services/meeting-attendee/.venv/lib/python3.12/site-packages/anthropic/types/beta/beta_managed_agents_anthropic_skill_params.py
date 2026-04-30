# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaManagedAgentsAnthropicSkillParams"]


class BetaManagedAgentsAnthropicSkillParams(TypedDict, total=False):
    """An Anthropic-managed skill."""

    skill_id: Required[str]
    """Identifier of the Anthropic skill (e.g., "xlsx")."""

    type: Required[Literal["anthropic"]]

    version: Optional[str]
    """Version to pin. Defaults to latest if omitted."""
