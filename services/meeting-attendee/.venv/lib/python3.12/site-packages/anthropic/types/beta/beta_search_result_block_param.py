# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Iterable, Optional
from typing_extensions import Literal, Required, TypedDict

from .beta_text_block_param import BetaTextBlockParam
from .beta_citations_config_param import BetaCitationsConfigParam
from .beta_cache_control_ephemeral_param import BetaCacheControlEphemeralParam

__all__ = ["BetaSearchResultBlockParam"]


class BetaSearchResultBlockParam(TypedDict, total=False):
    content: Required[Iterable[BetaTextBlockParam]]

    source: Required[str]

    title: Required[str]

    type: Required[Literal["search_result"]]

    cache_control: Optional[BetaCacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""

    citations: BetaCitationsConfigParam
