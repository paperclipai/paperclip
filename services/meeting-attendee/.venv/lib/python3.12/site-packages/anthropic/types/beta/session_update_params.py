# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Dict, List, Optional
from typing_extensions import Annotated, TypedDict

from ..._types import SequenceNotStr
from ..._utils import PropertyInfo
from ..anthropic_beta_param import AnthropicBetaParam

__all__ = ["SessionUpdateParams"]


class SessionUpdateParams(TypedDict, total=False):
    metadata: Optional[Dict[str, Optional[str]]]
    """Metadata patch.

    Set a key to a string to upsert it, or to null to delete it. Omit the field to
    preserve.
    """

    title: Optional[str]
    """Human-readable session title."""

    vault_ids: SequenceNotStr[str]
    """Vault IDs (`vlt_*`) to attach to the session.

    Not yet supported; requests setting this field are rejected. Reserved for future
    use.
    """

    betas: Annotated[List[AnthropicBetaParam], PropertyInfo(alias="anthropic-beta")]
    """Optional header to specify the beta version(s) you want to use."""
