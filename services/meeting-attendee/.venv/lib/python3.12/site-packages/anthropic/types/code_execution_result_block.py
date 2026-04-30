# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import List
from typing_extensions import Literal

from .._models import BaseModel
from .code_execution_output_block import CodeExecutionOutputBlock

__all__ = ["CodeExecutionResultBlock"]


class CodeExecutionResultBlock(BaseModel):
    content: List[CodeExecutionOutputBlock]

    return_code: int

    stderr: str

    stdout: str

    type: Literal["code_execution_result"]
