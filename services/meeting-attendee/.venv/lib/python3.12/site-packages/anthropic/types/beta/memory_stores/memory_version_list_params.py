# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List, Union
from datetime import datetime
from typing_extensions import Annotated, TypedDict

from ...._utils import PropertyInfo
from ...anthropic_beta_param import AnthropicBetaParam
from .beta_managed_agents_memory_view import BetaManagedAgentsMemoryView
from .beta_managed_agents_memory_version_operation import BetaManagedAgentsMemoryVersionOperation

__all__ = ["MemoryVersionListParams"]


class MemoryVersionListParams(TypedDict, total=False):
    api_key_id: str
    """Query parameter for api_key_id"""

    created_at_gte: Annotated[Union[str, datetime], PropertyInfo(alias="created_at[gte]", format="iso8601")]
    """Return versions created at or after this time (inclusive)."""

    created_at_lte: Annotated[Union[str, datetime], PropertyInfo(alias="created_at[lte]", format="iso8601")]
    """Return versions created at or before this time (inclusive)."""

    limit: int
    """Query parameter for limit"""

    memory_id: str
    """Query parameter for memory_id"""

    operation: BetaManagedAgentsMemoryVersionOperation
    """Query parameter for operation"""

    page: str
    """Query parameter for page"""

    session_id: str
    """Query parameter for session_id"""

    view: BetaManagedAgentsMemoryView
    """Query parameter for view"""

    betas: Annotated[List[AnthropicBetaParam], PropertyInfo(alias="anthropic-beta")]
    """Optional header to specify the beta version(s) you want to use."""
