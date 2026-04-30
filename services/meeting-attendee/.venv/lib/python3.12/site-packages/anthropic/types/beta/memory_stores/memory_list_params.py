# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List
from typing_extensions import Literal, Annotated, TypedDict

from ...._utils import PropertyInfo
from ...anthropic_beta_param import AnthropicBetaParam
from .beta_managed_agents_memory_view import BetaManagedAgentsMemoryView

__all__ = ["MemoryListParams"]


class MemoryListParams(TypedDict, total=False):
    depth: int
    """Query parameter for depth"""

    limit: int
    """Query parameter for limit"""

    order: Literal["asc", "desc"]
    """Query parameter for order"""

    order_by: str
    """Query parameter for order_by"""

    page: str
    """Query parameter for page"""

    path_prefix: str
    """
    Optional path prefix filter (raw string-prefix match; include a trailing slash
    for directory-scoped lists). This value appears in request URLs. Do not include
    secrets or personally identifiable information.
    """

    view: BetaManagedAgentsMemoryView
    """Query parameter for view"""

    betas: Annotated[List[AnthropicBetaParam], PropertyInfo(alias="anthropic-beta")]
    """Optional header to specify the beta version(s) you want to use."""
