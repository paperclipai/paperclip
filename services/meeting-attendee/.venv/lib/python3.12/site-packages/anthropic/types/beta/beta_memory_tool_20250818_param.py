# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Dict, List, Iterable, Optional
from typing_extensions import Literal, Required, TypedDict

from .beta_cache_control_ephemeral_param import BetaCacheControlEphemeralParam

__all__ = ["BetaMemoryTool20250818Param"]


class BetaMemoryTool20250818Param(TypedDict, total=False):
    name: Required[Literal["memory"]]
    """Name of the tool.

    This is how the tool will be called by the model and in `tool_use` blocks.
    """

    type: Required[Literal["memory_20250818"]]

    allowed_callers: List[Literal["direct", "code_execution_20250825", "code_execution_20260120"]]

    cache_control: Optional[BetaCacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""

    defer_loading: bool
    """If true, tool will not be included in initial system prompt.

    Only loaded when returned via tool_reference from tool search.
    """

    input_examples: Iterable[Dict[str, object]]

    strict: bool
    """When true, guarantees schema validation on tool names and inputs"""
