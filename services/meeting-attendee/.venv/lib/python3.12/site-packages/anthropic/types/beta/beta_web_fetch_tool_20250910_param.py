# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List, Optional
from typing_extensions import Literal, Required, TypedDict

from ..._types import SequenceNotStr
from .beta_citations_config_param import BetaCitationsConfigParam
from .beta_cache_control_ephemeral_param import BetaCacheControlEphemeralParam

__all__ = ["BetaWebFetchTool20250910Param"]


class BetaWebFetchTool20250910Param(TypedDict, total=False):
    name: Required[Literal["web_fetch"]]
    """Name of the tool.

    This is how the tool will be called by the model and in `tool_use` blocks.
    """

    type: Required[Literal["web_fetch_20250910"]]

    allowed_callers: List[Literal["direct", "code_execution_20250825", "code_execution_20260120"]]

    allowed_domains: Optional[SequenceNotStr[str]]
    """List of domains to allow fetching from"""

    blocked_domains: Optional[SequenceNotStr[str]]
    """List of domains to block fetching from"""

    cache_control: Optional[BetaCacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""

    citations: Optional[BetaCitationsConfigParam]
    """Citations configuration for fetched documents.

    Citations are disabled by default.
    """

    defer_loading: bool
    """If true, tool will not be included in initial system prompt.

    Only loaded when returned via tool_reference from tool search.
    """

    max_content_tokens: Optional[int]
    """Maximum number of tokens used by including web page text content in the context.

    The limit is approximate and does not apply to binary content such as PDFs.
    """

    max_uses: Optional[int]
    """Maximum number of times the tool can be used in the API request."""

    strict: bool
    """When true, guarantees schema validation on tool names and inputs"""
