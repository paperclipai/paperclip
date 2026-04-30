# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

from .beta_cache_control_ephemeral_param import BetaCacheControlEphemeralParam

__all__ = ["BetaToolReferenceBlockParam"]


class BetaToolReferenceBlockParam(TypedDict, total=False):
    """Tool reference block that can be included in tool_result content."""

    tool_name: Required[str]

    type: Required[Literal["tool_reference"]]

    cache_control: Optional[BetaCacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""
