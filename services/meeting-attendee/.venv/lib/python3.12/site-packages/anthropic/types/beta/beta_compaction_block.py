# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaCompactionBlock"]


class BetaCompactionBlock(BaseModel):
    """A compaction block returned when autocompact is triggered.

    When content is None, it indicates the compaction failed to produce a valid
    summary (e.g., malformed output from the model). Clients may round-trip
    compaction blocks with null content; the server treats them as no-ops.
    """

    content: Optional[str] = None
    """Summary of compacted content, or null if compaction failed"""

    encrypted_content: Optional[str] = None
    """Opaque metadata from prior compaction, to be round-tripped verbatim"""

    type: Literal["compaction"]
