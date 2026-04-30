# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaToolChoiceAutoParam"]


class BetaToolChoiceAutoParam(TypedDict, total=False):
    """The model will automatically decide whether to use tools."""

    type: Required[Literal["auto"]]

    disable_parallel_tool_use: bool
    """Whether to disable parallel tool use.

    Defaults to `false`. If set to `true`, the model will output at most one tool
    use.
    """
