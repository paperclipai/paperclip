# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaCitationPageLocation"]


class BetaCitationPageLocation(BaseModel):
    cited_text: str

    document_index: int

    document_title: Optional[str] = None

    end_page_number: int

    file_id: Optional[str] = None

    start_page_number: int

    type: Literal["page_location"]
