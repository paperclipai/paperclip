# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaTokenTaskBudgetParam"]


class BetaTokenTaskBudgetParam(TypedDict, total=False):
    """User-configurable total token budget across contexts."""

    total: Required[int]
    """Total token budget across all contexts in the session."""

    type: Required[Literal["tokens"]]
    """The budget type. Currently only 'tokens' is supported."""

    remaining: Optional[int]
    """Remaining tokens in the budget.

    Use this to track usage across contexts when implementing compaction
    client-side. Defaults to total if not provided.
    """
