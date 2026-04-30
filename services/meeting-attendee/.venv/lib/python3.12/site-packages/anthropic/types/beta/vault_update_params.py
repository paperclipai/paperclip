# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Dict, List, Optional
from typing_extensions import Annotated, TypedDict

from ..._utils import PropertyInfo
from ..anthropic_beta_param import AnthropicBetaParam

__all__ = ["VaultUpdateParams"]


class VaultUpdateParams(TypedDict, total=False):
    display_name: Optional[str]
    """Updated human-readable name for the vault. 1-255 characters."""

    metadata: Optional[Dict[str, Optional[str]]]
    """Metadata patch.

    Set a key to a string to upsert it, or to null to delete it. Omitted keys are
    preserved.
    """

    betas: Annotated[List[AnthropicBetaParam], PropertyInfo(alias="anthropic-beta")]
    """Optional header to specify the beta version(s) you want to use."""
