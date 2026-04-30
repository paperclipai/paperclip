# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List, Union
from datetime import datetime
from typing_extensions import Literal, Annotated, TypedDict

from ..._utils import PropertyInfo
from ..anthropic_beta_param import AnthropicBetaParam

__all__ = ["SessionListParams"]


class SessionListParams(TypedDict, total=False):
    agent_id: str
    """Filter sessions created with this agent ID."""

    agent_version: int
    """Filter by agent version. Only applies when agent_id is also set."""

    created_at_gt: Annotated[Union[str, datetime], PropertyInfo(alias="created_at[gt]", format="iso8601")]
    """Return sessions created after this time (exclusive)."""

    created_at_gte: Annotated[Union[str, datetime], PropertyInfo(alias="created_at[gte]", format="iso8601")]
    """Return sessions created at or after this time (inclusive)."""

    created_at_lt: Annotated[Union[str, datetime], PropertyInfo(alias="created_at[lt]", format="iso8601")]
    """Return sessions created before this time (exclusive)."""

    created_at_lte: Annotated[Union[str, datetime], PropertyInfo(alias="created_at[lte]", format="iso8601")]
    """Return sessions created at or before this time (inclusive)."""

    include_archived: bool
    """When true, includes archived sessions. Default: false (exclude archived)."""

    limit: int
    """Maximum number of results to return."""

    order: Literal["asc", "desc"]
    """Sort direction for results, ordered by created_at.

    Defaults to desc (newest first).
    """

    page: str
    """Opaque pagination cursor from a previous response's next_page."""

    betas: Annotated[List[AnthropicBetaParam], PropertyInfo(alias="anthropic-beta")]
    """Optional header to specify the beta version(s) you want to use."""
