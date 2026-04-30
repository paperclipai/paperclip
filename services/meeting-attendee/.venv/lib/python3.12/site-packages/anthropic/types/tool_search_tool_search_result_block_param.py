# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Iterable
from typing_extensions import Literal, Required, TypedDict

from .tool_reference_block_param import ToolReferenceBlockParam

__all__ = ["ToolSearchToolSearchResultBlockParam"]


class ToolSearchToolSearchResultBlockParam(TypedDict, total=False):
    tool_references: Required[Iterable[ToolReferenceBlockParam]]

    type: Required[Literal["tool_search_tool_search_result"]]
