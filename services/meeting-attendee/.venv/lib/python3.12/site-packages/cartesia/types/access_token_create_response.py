# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from .._models import BaseModel

__all__ = ["AccessTokenCreateResponse"]


class AccessTokenCreateResponse(BaseModel):
    token: str
    """The generated Access Token."""
