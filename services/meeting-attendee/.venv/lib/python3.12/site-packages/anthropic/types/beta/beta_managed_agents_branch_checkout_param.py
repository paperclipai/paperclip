# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaManagedAgentsBranchCheckoutParam"]


class BetaManagedAgentsBranchCheckoutParam(TypedDict, total=False):
    name: Required[str]
    """Branch name to check out."""

    type: Required[Literal["branch"]]
