# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import TypedDict

from ..._types import SequenceNotStr

__all__ = ["BetaRequestMCPServerToolConfigurationParam"]


class BetaRequestMCPServerToolConfigurationParam(TypedDict, total=False):
    allowed_tools: Optional[SequenceNotStr[str]]

    enabled: Optional[bool]
