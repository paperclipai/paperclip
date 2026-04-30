# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from datetime import datetime
from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaUserProfileEnrollmentURL"]


class BetaUserProfileEnrollmentURL(BaseModel):
    expires_at: datetime
    """A timestamp in RFC 3339 format"""

    type: Literal["enrollment_url"]
    """Object type. Always `enrollment_url`."""

    url: str
    """Enrollment URL to send to the end user. Valid until `expires_at`."""
