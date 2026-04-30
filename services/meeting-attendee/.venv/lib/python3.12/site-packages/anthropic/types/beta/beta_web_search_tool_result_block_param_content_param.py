# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Iterable
from typing_extensions import TypeAlias

from .beta_web_search_result_block_param import BetaWebSearchResultBlockParam
from .beta_web_search_tool_request_error_param import BetaWebSearchToolRequestErrorParam

__all__ = ["BetaWebSearchToolResultBlockParamContentParam"]

BetaWebSearchToolResultBlockParamContentParam: TypeAlias = Union[
    Iterable[BetaWebSearchResultBlockParam], BetaWebSearchToolRequestErrorParam
]
