# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List, Optional
from typing_extensions import Literal, Required, TypedDict

from ..model_param import ModelParam
from .beta_cache_control_ephemeral_param import BetaCacheControlEphemeralParam

__all__ = ["BetaAdvisorTool20260301Param"]


class BetaAdvisorTool20260301Param(TypedDict, total=False):
    model: Required[ModelParam]
    """
    The model that will complete your prompt.\n\nSee
    [models](https://docs.anthropic.com/en/docs/models-overview) for additional
    details and options.
    """

    name: Required[Literal["advisor"]]
    """Name of the tool.

    This is how the tool will be called by the model and in `tool_use` blocks.
    """

    type: Required[Literal["advisor_20260301"]]

    allowed_callers: List[Literal["direct", "code_execution_20250825", "code_execution_20260120"]]

    cache_control: Optional[BetaCacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""

    caching: Optional[BetaCacheControlEphemeralParam]
    """Caching for the advisor's own prompt.

    When set, each advisor call writes a cache entry at the given TTL so subsequent
    calls in the same conversation read the stable prefix. When omitted, the advisor
    prompt is not cached.
    """

    defer_loading: bool
    """If true, tool will not be included in initial system prompt.

    Only loaded when returned via tool_reference from tool search.
    """

    max_uses: Optional[int]
    """Maximum number of times the tool can be used in the API request."""

    strict: bool
    """When true, guarantees schema validation on tool names and inputs"""
