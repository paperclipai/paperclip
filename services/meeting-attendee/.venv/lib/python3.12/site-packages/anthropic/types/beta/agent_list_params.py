# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List, Union
from datetime import datetime
from typing_extensions import Annotated, TypedDict

from ..._utils import PropertyInfo
from ..anthropic_beta_param import AnthropicBetaParam

__all__ = ["AgentListParams"]


class AgentListParams(TypedDict, total=False):
    created_at_gte: Annotated[Union[str, datetime], PropertyInfo(alias="created_at[gte]", format="iso8601")]
    """Return agents created at or after this time (inclusive)."""

    created_at_lte: Annotated[Union[str, datetime], PropertyInfo(alias="created_at[lte]", format="iso8601")]
    """Return agents created at or before this time (inclusive)."""

    include_archived: bool
    """Include archived agents in results. Defaults to false."""

    limit: int
    """Maximum results per page. Default 20, maximum 100."""

    page: str
    """Opaque pagination cursor from a previous response."""

    betas: Annotated[List[AnthropicBetaParam], PropertyInfo(alias="anthropic-beta")]
    """Optional header to specify the beta version(s) you want to use."""
