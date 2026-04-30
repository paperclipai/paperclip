# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Dict, List, Iterable, Optional
from typing_extensions import Literal, Required, TypedDict

from .cache_control_ephemeral_param import CacheControlEphemeralParam

__all__ = ["ToolTextEditor20250124Param"]


class ToolTextEditor20250124Param(TypedDict, total=False):
    name: Required[Literal["str_replace_editor"]]
    """Name of the tool.

    This is how the tool will be called by the model and in `tool_use` blocks.
    """

    type: Required[Literal["text_editor_20250124"]]

    allowed_callers: List[Literal["direct", "code_execution_20250825", "code_execution_20260120"]]

    cache_control: Optional[CacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""

    defer_loading: bool
    """If true, tool will not be included in initial system prompt.

    Only loaded when returned via tool_reference from tool search.
    """

    input_examples: Iterable[Dict[str, object]]

    strict: bool
    """When true, guarantees schema validation on tool names and inputs"""
