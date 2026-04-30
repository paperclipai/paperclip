# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union, Optional
from typing_extensions import Literal, Annotated, TypeAlias

from .._utils import PropertyInfo
from .._models import BaseModel
from .direct_caller import DirectCaller
from .web_fetch_block import WebFetchBlock
from .server_tool_caller import ServerToolCaller
from .server_tool_caller_20260120 import ServerToolCaller20260120
from .web_fetch_tool_result_error_block import WebFetchToolResultErrorBlock

__all__ = ["WebFetchToolResultBlock", "Caller", "Content"]

Caller: TypeAlias = Annotated[
    Union[DirectCaller, ServerToolCaller, ServerToolCaller20260120], PropertyInfo(discriminator="type")
]

Content: TypeAlias = Union[WebFetchToolResultErrorBlock, WebFetchBlock]


class WebFetchToolResultBlock(BaseModel):
    caller: Optional[Caller] = None
    """Tool invocation directly from the model."""

    content: Content

    tool_use_id: str

    type: Literal["web_fetch_tool_result"]
