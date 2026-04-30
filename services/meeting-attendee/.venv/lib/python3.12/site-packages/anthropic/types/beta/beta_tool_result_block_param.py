# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Iterable, Optional
from typing_extensions import Literal, Required, TypeAlias, TypedDict

from .beta_text_block_param import BetaTextBlockParam
from .beta_image_block_param import BetaImageBlockParam
from .beta_search_result_block_param import BetaSearchResultBlockParam
from .beta_tool_reference_block_param import BetaToolReferenceBlockParam
from .beta_request_document_block_param import BetaRequestDocumentBlockParam
from .beta_cache_control_ephemeral_param import BetaCacheControlEphemeralParam

__all__ = ["BetaToolResultBlockParam", "Content"]

Content: TypeAlias = Union[
    BetaTextBlockParam,
    BetaImageBlockParam,
    BetaSearchResultBlockParam,
    BetaRequestDocumentBlockParam,
    BetaToolReferenceBlockParam,
]


class BetaToolResultBlockParam(TypedDict, total=False):
    tool_use_id: Required[str]

    type: Required[Literal["tool_result"]]

    cache_control: Optional[BetaCacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""

    content: Union[str, Iterable[Content]]

    is_error: bool
