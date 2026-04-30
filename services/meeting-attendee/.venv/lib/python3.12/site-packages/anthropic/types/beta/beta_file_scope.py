# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaFileScope"]


class BetaFileScope(BaseModel):
    id: str
    """The ID of the scoping resource (e.g., the session ID)."""

    type: Literal["session"]
    """The type of scope (e.g., `"session"`)."""
