# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Dict, Union, Optional
from typing_extensions import Literal, Annotated, TypeAlias

from ..._utils import PropertyInfo
from ..._models import BaseModel
from .beta_direct_caller import BetaDirectCaller
from .beta_server_tool_caller import BetaServerToolCaller
from .beta_server_tool_caller_20260120 import BetaServerToolCaller20260120

__all__ = ["BetaToolUseBlock", "Caller"]

Caller: TypeAlias = Annotated[
    Union[BetaDirectCaller, BetaServerToolCaller, BetaServerToolCaller20260120], PropertyInfo(discriminator="type")
]


class BetaToolUseBlock(BaseModel):
    id: str

    input: Dict[str, object]

    name: str

    type: Literal["tool_use"]

    caller: Optional[Caller] = None
    """Tool invocation directly from the model."""
