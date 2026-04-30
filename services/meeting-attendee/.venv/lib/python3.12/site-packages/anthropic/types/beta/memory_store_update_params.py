# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Dict, List, Optional
from typing_extensions import Annotated, TypedDict

from ..._utils import PropertyInfo
from ..anthropic_beta_param import AnthropicBetaParam

__all__ = ["MemoryStoreUpdateParams"]


class MemoryStoreUpdateParams(TypedDict, total=False):
    description: Optional[str]

    metadata: Optional[Dict[str, Optional[str]]]
    """Metadata patch.

    Set a key to a string to upsert it, or to null to delete it. Omit the field to
    preserve. The stored bag is limited to 16 keys (up to 64 chars each) with values
    up to 512 chars.
    """

    name: Optional[str]

    betas: Annotated[List[AnthropicBetaParam], PropertyInfo(alias="anthropic-beta")]
    """Optional header to specify the beta version(s) you want to use."""
