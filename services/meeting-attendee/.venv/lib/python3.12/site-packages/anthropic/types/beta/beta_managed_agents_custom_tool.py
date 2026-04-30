# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ..._models import BaseModel
from .beta_managed_agents_custom_tool_input_schema import BetaManagedAgentsCustomToolInputSchema

__all__ = ["BetaManagedAgentsCustomTool"]


class BetaManagedAgentsCustomTool(BaseModel):
    """A custom tool as returned in API responses."""

    description: str

    input_schema: BetaManagedAgentsCustomToolInputSchema
    """JSON Schema for custom tool input parameters."""

    name: str

    type: Literal["custom"]
