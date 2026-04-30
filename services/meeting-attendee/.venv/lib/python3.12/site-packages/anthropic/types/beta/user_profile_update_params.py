# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Dict, List, Optional
from typing_extensions import Annotated, TypedDict

from ..._utils import PropertyInfo
from ..anthropic_beta_param import AnthropicBetaParam

__all__ = ["UserProfileUpdateParams"]


class UserProfileUpdateParams(TypedDict, total=False):
    external_id: Optional[str]
    """If present, replaces the stored external_id.

    Omit to leave unchanged. Maximum 255 characters.
    """

    metadata: Dict[str, str]
    """Key-value pairs to merge into the stored metadata.

    Keys provided overwrite existing values. To remove a key, set its value to an
    empty string. Keys not provided are left unchanged. Maximum 16 keys, with keys
    up to 64 characters and values up to 512 characters.
    """

    betas: Annotated[List[AnthropicBetaParam], PropertyInfo(alias="anthropic-beta")]
    """Optional header to specify the beta version(s) you want to use."""
