# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Optional
from typing_extensions import Literal, Required, TypeAlias, TypedDict

from .beta_advisor_result_block_param import BetaAdvisorResultBlockParam
from .beta_cache_control_ephemeral_param import BetaCacheControlEphemeralParam
from .beta_advisor_tool_result_error_param import BetaAdvisorToolResultErrorParam
from .beta_advisor_redacted_result_block_param import BetaAdvisorRedactedResultBlockParam

__all__ = ["BetaAdvisorToolResultBlockParam", "Content"]

Content: TypeAlias = Union[
    BetaAdvisorToolResultErrorParam, BetaAdvisorResultBlockParam, BetaAdvisorRedactedResultBlockParam
]


class BetaAdvisorToolResultBlockParam(TypedDict, total=False):
    content: Required[Content]

    tool_use_id: Required[str]

    type: Required[Literal["advisor_tool_result"]]

    cache_control: Optional[BetaCacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""
