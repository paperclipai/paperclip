# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union, Optional
from typing_extensions import Literal, Annotated, TypeAlias

from .._utils import PropertyInfo
from .._models import BaseModel
from .direct_caller import DirectCaller
from .server_tool_caller import ServerToolCaller
from .server_tool_caller_20260120 import ServerToolCaller20260120
from .web_search_tool_result_block_content import WebSearchToolResultBlockContent

__all__ = ["WebSearchToolResultBlock", "Caller"]

Caller: TypeAlias = Annotated[
    Union[DirectCaller, ServerToolCaller, ServerToolCaller20260120], PropertyInfo(discriminator="type")
]


class WebSearchToolResultBlock(BaseModel):
    caller: Optional[Caller] = None
    """Tool invocation directly from the model."""

    content: WebSearchToolResultBlockContent

    tool_use_id: str

    type: Literal["web_search_tool_result"]
