# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union, Optional
from typing_extensions import Literal, Annotated, TypeAlias

from ..._utils import PropertyInfo
from ..._models import BaseModel
from .beta_direct_caller import BetaDirectCaller
from .beta_server_tool_caller import BetaServerToolCaller
from .beta_server_tool_caller_20260120 import BetaServerToolCaller20260120
from .beta_web_search_tool_result_block_content import BetaWebSearchToolResultBlockContent

__all__ = ["BetaWebSearchToolResultBlock", "Caller"]

Caller: TypeAlias = Annotated[
    Union[BetaDirectCaller, BetaServerToolCaller, BetaServerToolCaller20260120], PropertyInfo(discriminator="type")
]


class BetaWebSearchToolResultBlock(BaseModel):
    content: BetaWebSearchToolResultBlockContent

    tool_use_id: str

    type: Literal["web_search_tool_result"]

    caller: Optional[Caller] = None
    """Tool invocation directly from the model."""
