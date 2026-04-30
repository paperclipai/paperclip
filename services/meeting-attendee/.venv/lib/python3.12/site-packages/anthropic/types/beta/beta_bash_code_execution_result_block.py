# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import List
from typing_extensions import Literal

from ..._models import BaseModel
from .beta_bash_code_execution_output_block import BetaBashCodeExecutionOutputBlock

__all__ = ["BetaBashCodeExecutionResultBlock"]


class BetaBashCodeExecutionResultBlock(BaseModel):
    content: List[BetaBashCodeExecutionOutputBlock]

    return_code: int

    stderr: str

    stdout: str

    type: Literal["bash_code_execution_result"]
