# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Dict, List
from typing_extensions import Required, Annotated, TypedDict

from ..._utils import PropertyInfo
from ..anthropic_beta_param import AnthropicBetaParam

__all__ = ["VaultCreateParams"]


class VaultCreateParams(TypedDict, total=False):
    display_name: Required[str]
    """Human-readable name for the vault. 1-255 characters."""

    metadata: Dict[str, str]
    """Arbitrary key-value metadata to attach to the vault.

    Maximum 16 pairs, keys up to 64 chars, values up to 512 chars.
    """

    betas: Annotated[List[AnthropicBetaParam], PropertyInfo(alias="anthropic-beta")]
    """Optional header to specify the beta version(s) you want to use."""
