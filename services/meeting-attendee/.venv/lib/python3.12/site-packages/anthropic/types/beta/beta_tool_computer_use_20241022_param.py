# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Dict, List, Iterable, Optional
from typing_extensions import Literal, Required, TypedDict

from .beta_cache_control_ephemeral_param import BetaCacheControlEphemeralParam

__all__ = ["BetaToolComputerUse20241022Param"]


class BetaToolComputerUse20241022Param(TypedDict, total=False):
    display_height_px: Required[int]
    """The height of the display in pixels."""

    display_width_px: Required[int]
    """The width of the display in pixels."""

    name: Required[Literal["computer"]]
    """Name of the tool.

    This is how the tool will be called by the model and in `tool_use` blocks.
    """

    type: Required[Literal["computer_20241022"]]

    allowed_callers: List[Literal["direct", "code_execution_20250825", "code_execution_20260120"]]

    cache_control: Optional[BetaCacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""

    defer_loading: bool
    """If true, tool will not be included in initial system prompt.

    Only loaded when returned via tool_reference from tool search.
    """

    display_number: Optional[int]
    """The X11 display number (e.g. 0, 1) for the display."""

    input_examples: Iterable[Dict[str, object]]

    strict: bool
    """When true, guarantees schema validation on tool names and inputs"""
