# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union, Optional
from typing_extensions import Literal, Annotated, TypeAlias

from ...._utils import PropertyInfo
from ...._models import BaseModel
from .beta_managed_agents_url_document_source import BetaManagedAgentsURLDocumentSource
from .beta_managed_agents_file_document_source import BetaManagedAgentsFileDocumentSource
from .beta_managed_agents_base64_document_source import BetaManagedAgentsBase64DocumentSource
from .beta_managed_agents_plain_text_document_source import BetaManagedAgentsPlainTextDocumentSource

__all__ = ["BetaManagedAgentsDocumentBlock", "Source"]

Source: TypeAlias = Annotated[
    Union[
        BetaManagedAgentsBase64DocumentSource,
        BetaManagedAgentsPlainTextDocumentSource,
        BetaManagedAgentsURLDocumentSource,
        BetaManagedAgentsFileDocumentSource,
    ],
    PropertyInfo(discriminator="type"),
]


class BetaManagedAgentsDocumentBlock(BaseModel):
    """
    Document content, either specified directly as base64 data, as text, or as a reference via a URL.
    """

    source: Source
    """Union type for document source variants."""

    type: Literal["document"]

    context: Optional[str] = None
    """Additional context about the document for the model."""

    title: Optional[str] = None
    """The title of the document."""
