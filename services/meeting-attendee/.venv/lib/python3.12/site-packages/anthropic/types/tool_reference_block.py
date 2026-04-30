# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from .._models import BaseModel

__all__ = ["ToolReferenceBlock"]


class ToolReferenceBlock(BaseModel):
    tool_name: str

    type: Literal["tool_reference"]
