# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Optional
from typing_extensions import Literal, Required, TypeAlias, TypedDict

from .beta_url_pdf_source_param import BetaURLPDFSourceParam
from .beta_citations_config_param import BetaCitationsConfigParam
from .beta_base64_pdf_source_param import BetaBase64PDFSourceParam
from .beta_plain_text_source_param import BetaPlainTextSourceParam
from .beta_content_block_source_param import BetaContentBlockSourceParam
from .beta_file_document_source_param import BetaFileDocumentSourceParam
from .beta_cache_control_ephemeral_param import BetaCacheControlEphemeralParam

__all__ = ["BetaRequestDocumentBlockParam", "Source"]

Source: TypeAlias = Union[
    BetaBase64PDFSourceParam,
    BetaPlainTextSourceParam,
    BetaContentBlockSourceParam,
    BetaURLPDFSourceParam,
    BetaFileDocumentSourceParam,
]


class BetaRequestDocumentBlockParam(TypedDict, total=False):
    source: Required[Source]

    type: Required[Literal["document"]]

    cache_control: Optional[BetaCacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""

    citations: Optional[BetaCitationsConfigParam]

    context: Optional[str]

    title: Optional[str]
