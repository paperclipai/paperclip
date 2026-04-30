# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from .._models import BaseModel

__all__ = ["DirectCaller"]


class DirectCaller(BaseModel):
    """Tool invocation directly from the model."""

    type: Literal["direct"]
