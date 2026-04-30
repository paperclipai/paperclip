# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Dict, Union, Optional
from typing_extensions import Literal, Annotated, TypeAlias

from .._utils import PropertyInfo
from .._models import BaseModel
from .direct_caller import DirectCaller
from .server_tool_caller import ServerToolCaller
from .server_tool_caller_20260120 import ServerToolCaller20260120

__all__ = ["ToolUseBlock", "Caller"]

Caller: TypeAlias = Annotated[
    Union[DirectCaller, ServerToolCaller, ServerToolCaller20260120], PropertyInfo(discriminator="type")
]


class ToolUseBlock(BaseModel):
    id: str

    caller: Optional[Caller] = None
    """Tool invocation directly from the model."""

    input: Dict[str, object]

    name: str

    type: Literal["tool_use"]
