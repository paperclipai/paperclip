# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Optional
from typing_extensions import Literal, Required, TypeAlias, TypedDict

from .url_pdf_source_param import URLPDFSourceParam
from .citations_config_param import CitationsConfigParam
from .base64_pdf_source_param import Base64PDFSourceParam
from .plain_text_source_param import PlainTextSourceParam
from .content_block_source_param import ContentBlockSourceParam
from .cache_control_ephemeral_param import CacheControlEphemeralParam

__all__ = ["DocumentBlockParam", "Source"]

Source: TypeAlias = Union[Base64PDFSourceParam, PlainTextSourceParam, ContentBlockSourceParam, URLPDFSourceParam]


class DocumentBlockParam(TypedDict, total=False):
    source: Required[Source]

    type: Required[Literal["document"]]

    cache_control: Optional[CacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""

    citations: Optional[CitationsConfigParam]

    context: Optional[str]

    title: Optional[str]
