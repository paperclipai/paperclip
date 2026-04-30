# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import List, Optional
from typing_extensions import Literal

from ..._models import BaseModel
from .beta_text_citation import BetaTextCitation

__all__ = ["BetaTextBlock"]


class BetaTextBlock(BaseModel):
    citations: Optional[List[BetaTextCitation]] = None
    """Citations supporting the text block.

    The type of citation returned will depend on the type of document being cited.
    Citing a PDF results in `page_location`, plain text results in `char_location`,
    and content document results in `content_block_location`.
    """

    text: str

    type: Literal["text"]
