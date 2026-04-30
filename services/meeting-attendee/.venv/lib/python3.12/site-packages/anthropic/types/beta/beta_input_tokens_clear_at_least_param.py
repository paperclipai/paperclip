# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaInputTokensClearAtLeastParam"]


class BetaInputTokensClearAtLeastParam(TypedDict, total=False):
    type: Required[Literal["input_tokens"]]

    value: Required[int]
