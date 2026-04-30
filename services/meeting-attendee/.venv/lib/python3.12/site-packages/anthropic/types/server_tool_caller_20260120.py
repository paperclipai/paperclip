# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from .._models import BaseModel

__all__ = ["ServerToolCaller20260120"]


class ServerToolCaller20260120(BaseModel):
    tool_id: str

    type: Literal["code_execution_20260120"]
