# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union, Optional
from typing_extensions import Literal, Annotated, TypeAlias

from .._utils import PropertyInfo
from .._models import BaseModel
from .citations_config import CitationsConfig
from .base64_pdf_source import Base64PDFSource
from .plain_text_source import PlainTextSource

__all__ = ["DocumentBlock", "Source"]

Source: TypeAlias = Annotated[Union[Base64PDFSource, PlainTextSource], PropertyInfo(discriminator="type")]


class DocumentBlock(BaseModel):
    citations: Optional[CitationsConfig] = None
    """Citation configuration for the document"""

    source: Source

    title: Optional[str] = None
    """The title of the document"""

    type: Literal["document"]
