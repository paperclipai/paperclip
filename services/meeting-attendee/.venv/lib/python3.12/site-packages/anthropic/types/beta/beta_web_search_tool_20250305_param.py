# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List, Optional
from typing_extensions import Literal, Required, TypedDict

from ..._types import SequenceNotStr
from .beta_user_location_param import BetaUserLocationParam
from .beta_cache_control_ephemeral_param import BetaCacheControlEphemeralParam

__all__ = ["BetaWebSearchTool20250305Param"]


class BetaWebSearchTool20250305Param(TypedDict, total=False):
    name: Required[Literal["web_search"]]
    """Name of the tool.

    This is how the tool will be called by the model and in `tool_use` blocks.
    """

    type: Required[Literal["web_search_20250305"]]

    allowed_callers: List[Literal["direct", "code_execution_20250825", "code_execution_20260120"]]

    allowed_domains: Optional[SequenceNotStr[str]]
    """If provided, only these domains will be included in results.

    Cannot be used alongside `blocked_domains`.
    """

    blocked_domains: Optional[SequenceNotStr[str]]
    """If provided, these domains will never appear in results.

    Cannot be used alongside `allowed_domains`.
    """

    cache_control: Optional[BetaCacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""

    defer_loading: bool
    """If true, tool will not be included in initial system prompt.

    Only loaded when returned via tool_reference from tool search.
    """

    max_uses: Optional[int]
    """Maximum number of times the tool can be used in the API request."""

    strict: bool
    """When true, guarantees schema validation on tool names and inputs"""

    user_location: Optional[BetaUserLocationParam]
    """Parameters for the user's location.

    Used to provide more relevant search results.
    """
