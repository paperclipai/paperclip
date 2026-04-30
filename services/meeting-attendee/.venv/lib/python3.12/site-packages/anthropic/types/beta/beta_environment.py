# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Dict, Optional
from typing_extensions import Literal

from ..._models import BaseModel
from .beta_cloud_config import BetaCloudConfig

__all__ = ["BetaEnvironment"]


class BetaEnvironment(BaseModel):
    """Unified Environment resource for both cloud and BYOC environments."""

    id: str
    """Environment identifier (e.g., 'env\\__...')"""

    archived_at: Optional[str] = None
    """RFC 3339 timestamp when environment was archived, or null if not archived"""

    config: BetaCloudConfig
    """`cloud` environment configuration."""

    created_at: str
    """RFC 3339 timestamp when environment was created"""

    description: str
    """User-provided description for the environment"""

    metadata: Dict[str, str]
    """User-provided metadata key-value pairs"""

    name: str
    """Human-readable name for the environment"""

    type: Literal["environment"]
    """The type of object (always 'environment')"""

    updated_at: str
    """RFC 3339 timestamp when environment was last updated"""
