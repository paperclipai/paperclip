# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Optional
from typing_extensions import Literal, Required, TypeAlias, TypedDict

from .beta_managed_agents_url_document_source_param import BetaManagedAgentsURLDocumentSourceParam
from .beta_managed_agents_file_document_source_param import BetaManagedAgentsFileDocumentSourceParam
from .beta_managed_agents_base64_document_source_param import BetaManagedAgentsBase64DocumentSourceParam
from .beta_managed_agents_plain_text_document_source_param import BetaManagedAgentsPlainTextDocumentSourceParam

__all__ = ["BetaManagedAgentsDocumentBlockParam", "Source"]

Source: TypeAlias = Union[
    BetaManagedAgentsBase64DocumentSourceParam,
    BetaManagedAgentsPlainTextDocumentSourceParam,
    BetaManagedAgentsURLDocumentSourceParam,
    BetaManagedAgentsFileDocumentSourceParam,
]


class BetaManagedAgentsDocumentBlockParam(TypedDict, total=False):
    """
    Document content, either specified directly as base64 data, as text, or as a reference via a URL.
    """

    source: Required[Source]
    """Union type for document source variants."""

    type: Required[Literal["document"]]

    context: Optional[str]
    """Additional context about the document for the model."""

    title: Optional[str]
    """The title of the document."""
