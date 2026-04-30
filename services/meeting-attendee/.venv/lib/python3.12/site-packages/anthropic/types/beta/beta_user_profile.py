# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Dict, Optional
from datetime import datetime
from typing_extensions import Literal

from ..._models import BaseModel
from .beta_user_profile_trust_grant import BetaUserProfileTrustGrant

__all__ = ["BetaUserProfile"]


class BetaUserProfile(BaseModel):
    id: str
    """Unique identifier for this user profile, prefixed `uprof_`."""

    created_at: datetime
    """A timestamp in RFC 3339 format"""

    metadata: Dict[str, str]
    """Arbitrary key-value metadata.

    Maximum 16 pairs, keys up to 64 chars, values up to 512 chars.
    """

    trust_grants: Dict[str, BetaUserProfileTrustGrant]
    """Trust grants for this profile, keyed by grant name.

    Key omitted when no grant is active or in flight.
    """

    type: Literal["user_profile"]
    """Object type. Always `user_profile`."""

    updated_at: datetime
    """A timestamp in RFC 3339 format"""

    external_id: Optional[str] = None
    """Platform's own identifier for this user. Not enforced unique."""
