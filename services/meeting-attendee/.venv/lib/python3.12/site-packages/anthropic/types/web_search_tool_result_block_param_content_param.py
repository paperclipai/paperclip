# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Iterable
from typing_extensions import TypeAlias

from .web_search_result_block_param import WebSearchResultBlockParam
from .web_search_tool_request_error_param import WebSearchToolRequestErrorParam

__all__ = ["WebSearchToolResultBlockParamContentParam"]

WebSearchToolResultBlockParamContentParam: TypeAlias = Union[
    Iterable[WebSearchResultBlockParam], WebSearchToolRequestErrorParam
]
