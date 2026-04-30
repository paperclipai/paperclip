# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from typing_extensions import Literal

from .._models import BaseModel

__all__ = ["RefusalStopDetails"]


class RefusalStopDetails(BaseModel):
    """Structured information about a refusal."""

    category: Optional[Literal["cyber", "bio"]] = None
    """The policy category that triggered the refusal.

    `null` when the refusal doesn't map to a named category.
    """

    explanation: Optional[str] = None
    """Human-readable explanation of the refusal.

    This text is not guaranteed to be stable. `null` when no explanation is
    available for the category.
    """

    type: Literal["refusal"]
