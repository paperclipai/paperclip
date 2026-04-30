# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Iterable, Optional
from typing_extensions import Literal, Required, TypedDict

from .text_citation_param import TextCitationParam
from .cache_control_ephemeral_param import CacheControlEphemeralParam

__all__ = ["TextBlockParam"]


class TextBlockParam(TypedDict, total=False):
    text: Required[str]

    type: Required[Literal["text"]]

    cache_control: Optional[CacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""

    citations: Optional[Iterable[TextCitationParam]]
