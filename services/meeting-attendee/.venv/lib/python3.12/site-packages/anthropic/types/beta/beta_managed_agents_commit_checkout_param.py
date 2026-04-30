# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaManagedAgentsCommitCheckoutParam"]


class BetaManagedAgentsCommitCheckoutParam(TypedDict, total=False):
    sha: Required[str]
    """Full commit SHA to check out."""

    type: Required[Literal["commit"]]
