# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaManagedAgentsUserInterruptEventParams"]


class BetaManagedAgentsUserInterruptEventParams(TypedDict, total=False):
    """Parameters for sending an interrupt to pause the agent."""

    type: Required[Literal["user.interrupt"]]
