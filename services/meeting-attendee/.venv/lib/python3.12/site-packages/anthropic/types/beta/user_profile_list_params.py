# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List
from typing_extensions import Literal, Annotated, TypedDict

from ..._utils import PropertyInfo
from ..anthropic_beta_param import AnthropicBetaParam

__all__ = ["UserProfileListParams"]


class UserProfileListParams(TypedDict, total=False):
    limit: int
    """Query parameter for limit"""

    order: Literal["asc", "desc"]
    """Query parameter for order"""

    page: str
    """Query parameter for page"""

    betas: Annotated[List[AnthropicBetaParam], PropertyInfo(alias="anthropic-beta")]
    """Optional header to specify the beta version(s) you want to use."""
