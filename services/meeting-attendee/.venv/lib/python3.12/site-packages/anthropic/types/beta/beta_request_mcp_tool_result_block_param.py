# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Iterable, Optional
from typing_extensions import Literal, Required, TypedDict

from .beta_text_block_param import BetaTextBlockParam
from .beta_cache_control_ephemeral_param import BetaCacheControlEphemeralParam

__all__ = ["BetaRequestMCPToolResultBlockParam"]


class BetaRequestMCPToolResultBlockParam(TypedDict, total=False):
    tool_use_id: Required[str]

    type: Required[Literal["mcp_tool_result"]]

    cache_control: Optional[BetaCacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""

    content: Union[str, Iterable[BetaTextBlockParam]]

    is_error: bool
