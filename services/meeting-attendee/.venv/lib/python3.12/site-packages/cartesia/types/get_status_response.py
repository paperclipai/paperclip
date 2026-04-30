# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from .._models import BaseModel

__all__ = ["GetStatusResponse"]


class GetStatusResponse(BaseModel):
    ok: bool

    version: str
