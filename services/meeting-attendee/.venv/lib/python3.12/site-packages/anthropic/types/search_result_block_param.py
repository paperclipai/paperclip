# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Iterable, Optional
from typing_extensions import Literal, Required, TypedDict

from .text_block_param import TextBlockParam
from .citations_config_param import CitationsConfigParam
from .cache_control_ephemeral_param import CacheControlEphemeralParam

__all__ = ["SearchResultBlockParam"]


class SearchResultBlockParam(TypedDict, total=False):
    content: Required[Iterable[TextBlockParam]]

    source: Required[str]

    title: Required[str]

    type: Required[Literal["search_result"]]

    cache_control: Optional[CacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""

    citations: CitationsConfigParam
