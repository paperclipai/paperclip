# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Literal, TypeAlias

from ..._models import BaseModel
from .beta_tool_search_tool_result_error import BetaToolSearchToolResultError
from .beta_tool_search_tool_search_result_block import BetaToolSearchToolSearchResultBlock

__all__ = ["BetaToolSearchToolResultBlock", "Content"]

Content: TypeAlias = Union[BetaToolSearchToolResultError, BetaToolSearchToolSearchResultBlock]


class BetaToolSearchToolResultBlock(BaseModel):
    content: Content

    tool_use_id: str

    type: Literal["tool_search_tool_result"]
