# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import List
from typing_extensions import Literal

from ..._models import BaseModel
from .beta_code_execution_output_block import BetaCodeExecutionOutputBlock

__all__ = ["BetaEncryptedCodeExecutionResultBlock"]


class BetaEncryptedCodeExecutionResultBlock(BaseModel):
    """Code execution result with encrypted stdout for PFC + web_search results."""

    content: List[BetaCodeExecutionOutputBlock]

    encrypted_stdout: str

    return_code: int

    stderr: str

    type: Literal["encrypted_code_execution_result"]
