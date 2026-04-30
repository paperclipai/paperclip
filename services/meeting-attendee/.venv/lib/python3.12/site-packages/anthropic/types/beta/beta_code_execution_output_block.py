# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaCodeExecutionOutputBlock"]


class BetaCodeExecutionOutputBlock(BaseModel):
    file_id: str

    type: Literal["code_execution_output"]
