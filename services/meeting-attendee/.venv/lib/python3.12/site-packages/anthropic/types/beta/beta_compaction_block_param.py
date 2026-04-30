# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

from .beta_cache_control_ephemeral_param import BetaCacheControlEphemeralParam

__all__ = ["BetaCompactionBlockParam"]


class BetaCompactionBlockParam(TypedDict, total=False):
    """A compaction block containing summary of previous context.

    Users should round-trip these blocks from responses to subsequent requests
    to maintain context across compaction boundaries.

    When content is None, the block represents a failed compaction. The server
    treats these as no-ops. Empty string content is not allowed.
    """

    content: Required[Optional[str]]
    """Summary of previously compacted content, or null if compaction failed"""

    type: Required[Literal["compaction"]]

    cache_control: Optional[BetaCacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""

    encrypted_content: Optional[str]
    """Opaque metadata from prior compaction, to be round-tripped verbatim"""
