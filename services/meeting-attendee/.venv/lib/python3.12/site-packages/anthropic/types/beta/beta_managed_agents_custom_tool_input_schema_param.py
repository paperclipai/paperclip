# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Dict, Optional
from typing_extensions import Literal, TypedDict

from ..._types import SequenceNotStr

__all__ = ["BetaManagedAgentsCustomToolInputSchemaParam"]


class BetaManagedAgentsCustomToolInputSchemaParam(TypedDict, total=False):
    """JSON Schema for custom tool input parameters."""

    properties: Optional[Dict[str, object]]
    """JSON Schema properties defining the tool's input parameters."""

    required: SequenceNotStr[str]
    """List of required property names."""

    type: Literal["object"]
    """Must be 'object' for tool input schemas."""
