# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Iterable, Optional
from typing_extensions import Literal, Required, TypedDict

from .beta_text_citation_param import BetaTextCitationParam
from .beta_cache_control_ephemeral_param import BetaCacheControlEphemeralParam

__all__ = ["BetaTextBlockParam"]


class BetaTextBlockParam(TypedDict, total=False):
    text: Required[str]

    type: Required[Literal["text"]]

    cache_control: Optional[BetaCacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""

    citations: Optional[Iterable[BetaTextCitationParam]]
