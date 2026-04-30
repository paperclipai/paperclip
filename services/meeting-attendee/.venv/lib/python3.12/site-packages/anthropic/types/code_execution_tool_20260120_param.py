# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List, Optional
from typing_extensions import Literal, Required, TypedDict

from .cache_control_ephemeral_param import CacheControlEphemeralParam

__all__ = ["CodeExecutionTool20260120Param"]


class CodeExecutionTool20260120Param(TypedDict, total=False):
    """
    Code execution tool with REPL state persistence (daemon mode + gVisor checkpoint).
    """

    name: Required[Literal["code_execution"]]
    """Name of the tool.

    This is how the tool will be called by the model and in `tool_use` blocks.
    """

    type: Required[Literal["code_execution_20260120"]]

    allowed_callers: List[Literal["direct", "code_execution_20250825", "code_execution_20260120"]]

    cache_control: Optional[CacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""

    defer_loading: bool
    """If true, tool will not be included in initial system prompt.

    Only loaded when returned via tool_reference from tool search.
    """

    strict: bool
    """When true, guarantees schema validation on tool names and inputs"""
