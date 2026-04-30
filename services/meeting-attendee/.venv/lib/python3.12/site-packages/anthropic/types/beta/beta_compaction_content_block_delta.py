# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaCompactionContentBlockDelta"]


class BetaCompactionContentBlockDelta(BaseModel):
    content: Optional[str] = None

    encrypted_content: Optional[str] = None
    """Opaque metadata from prior compaction, to be round-tripped verbatim"""

    type: Literal["compaction_delta"]
