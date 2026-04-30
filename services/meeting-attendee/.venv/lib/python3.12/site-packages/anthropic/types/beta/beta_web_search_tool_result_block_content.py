# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import List, Union
from typing_extensions import TypeAlias

from .beta_web_search_result_block import BetaWebSearchResultBlock
from .beta_web_search_tool_result_error import BetaWebSearchToolResultError

__all__ = ["BetaWebSearchToolResultBlockContent"]

BetaWebSearchToolResultBlockContent: TypeAlias = Union[BetaWebSearchToolResultError, List[BetaWebSearchResultBlock]]
