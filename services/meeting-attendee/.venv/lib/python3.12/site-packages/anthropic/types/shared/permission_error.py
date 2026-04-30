# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["PermissionError"]


class PermissionError(BaseModel):
    message: str

    type: Literal["permission_error"]
