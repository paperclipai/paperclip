# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaManagedAgentsAgentParams"]


class BetaManagedAgentsAgentParams(TypedDict, total=False):
    """Specification for an Agent.

    Provide a specific `version` or use the short-form `agent="agent_id"` for the most recent version
    """

    id: Required[str]
    """The `agent` ID."""

    type: Required[Literal["agent"]]

    version: int
    """The specific `agent` version to use.

    Omit to use the latest version. Must be at least 1 if specified.
    """
