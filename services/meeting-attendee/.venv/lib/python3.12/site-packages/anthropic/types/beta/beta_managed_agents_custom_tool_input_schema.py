# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Dict, List, Optional
from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaManagedAgentsCustomToolInputSchema"]


class BetaManagedAgentsCustomToolInputSchema(BaseModel):
    """JSON Schema for custom tool input parameters."""

    properties: Optional[Dict[str, object]] = None
    """JSON Schema properties defining the tool's input parameters."""

    required: Optional[List[str]] = None
    """List of required property names."""

    type: Optional[Literal["object"]] = None
    """Must be 'object' for tool input schemas."""
