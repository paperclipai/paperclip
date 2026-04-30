# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import List, Union
from typing_extensions import Literal

from ..._models import BaseModel
from .beta_text_block import BetaTextBlock

__all__ = ["BetaMCPToolResultBlock"]


class BetaMCPToolResultBlock(BaseModel):
    content: Union[str, List[BetaTextBlock]]

    is_error: bool

    tool_use_id: str

    type: Literal["mcp_tool_result"]
