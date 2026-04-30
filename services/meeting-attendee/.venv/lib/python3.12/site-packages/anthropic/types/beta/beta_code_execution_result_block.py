# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import List
from typing_extensions import Literal

from ..._models import BaseModel
from .beta_code_execution_output_block import BetaCodeExecutionOutputBlock

__all__ = ["BetaCodeExecutionResultBlock"]


class BetaCodeExecutionResultBlock(BaseModel):
    content: List[BetaCodeExecutionOutputBlock]

    return_code: int

    stderr: str

    stdout: str

    type: Literal["code_execution_result"]
