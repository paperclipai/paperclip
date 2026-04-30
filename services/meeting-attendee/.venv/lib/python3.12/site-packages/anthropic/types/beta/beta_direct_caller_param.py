# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaDirectCallerParam"]


class BetaDirectCallerParam(TypedDict, total=False):
    """Tool invocation directly from the model."""

    type: Required[Literal["direct"]]
