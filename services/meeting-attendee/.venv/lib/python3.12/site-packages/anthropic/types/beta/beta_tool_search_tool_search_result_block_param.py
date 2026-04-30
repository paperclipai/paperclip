# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Iterable
from typing_extensions import Literal, Required, TypedDict

from .beta_tool_reference_block_param import BetaToolReferenceBlockParam

__all__ = ["BetaToolSearchToolSearchResultBlockParam"]


class BetaToolSearchToolSearchResultBlockParam(TypedDict, total=False):
    tool_references: Required[Iterable[BetaToolReferenceBlockParam]]

    type: Required[Literal["tool_search_tool_search_result"]]
