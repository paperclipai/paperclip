# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import List, Optional
from typing_extensions import Literal

from .._models import BaseModel
from .text_citation import TextCitation

__all__ = ["TextBlock"]


class TextBlock(BaseModel):
    citations: Optional[List[TextCitation]] = None
    """Citations supporting the text block.

    The type of citation returned will depend on the type of document being cited.
    Citing a PDF results in `page_location`, plain text results in `char_location`,
    and content document results in `content_block_location`.
    """

    text: str

    type: Literal["text"]
