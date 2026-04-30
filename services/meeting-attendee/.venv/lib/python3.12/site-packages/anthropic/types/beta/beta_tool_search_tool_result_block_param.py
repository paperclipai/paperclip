# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Optional
from typing_extensions import Literal, Required, TypeAlias, TypedDict

from .beta_cache_control_ephemeral_param import BetaCacheControlEphemeralParam
from .beta_tool_search_tool_result_error_param import BetaToolSearchToolResultErrorParam
from .beta_tool_search_tool_search_result_block_param import BetaToolSearchToolSearchResultBlockParam

__all__ = ["BetaToolSearchToolResultBlockParam", "Content"]

Content: TypeAlias = Union[BetaToolSearchToolResultErrorParam, BetaToolSearchToolSearchResultBlockParam]


class BetaToolSearchToolResultBlockParam(TypedDict, total=False):
    content: Required[Content]

    tool_use_id: Required[str]

    type: Required[Literal["tool_search_tool_result"]]

    cache_control: Optional[BetaCacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""
