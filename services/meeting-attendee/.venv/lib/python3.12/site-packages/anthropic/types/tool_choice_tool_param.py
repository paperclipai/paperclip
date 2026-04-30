# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

__all__ = ["ToolChoiceToolParam"]


class ToolChoiceToolParam(TypedDict, total=False):
    """The model will use the specified tool with `tool_choice.name`."""

    name: Required[str]
    """The name of the tool to use."""

    type: Required[Literal["tool"]]

    disable_parallel_tool_use: bool
    """Whether to disable parallel tool use.

    Defaults to `false`. If set to `true`, the model will output exactly one tool
    use.
    """
