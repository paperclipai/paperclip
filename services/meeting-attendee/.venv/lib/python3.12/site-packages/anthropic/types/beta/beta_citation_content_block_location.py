# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaCitationContentBlockLocation"]


class BetaCitationContentBlockLocation(BaseModel):
    cited_text: str

    document_index: int

    document_title: Optional[str] = None

    end_block_index: int

    file_id: Optional[str] = None

    start_block_index: int

    type: Literal["content_block_location"]
