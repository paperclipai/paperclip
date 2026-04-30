# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

__all__ = ["ToolChoiceNoneParam"]


class ToolChoiceNoneParam(TypedDict, total=False):
    """The model will not be allowed to use tools."""

    type: Required[Literal["none"]]
