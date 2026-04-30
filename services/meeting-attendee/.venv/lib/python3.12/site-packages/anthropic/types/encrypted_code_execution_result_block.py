# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import List
from typing_extensions import Literal

from .._models import BaseModel
from .code_execution_output_block import CodeExecutionOutputBlock

__all__ = ["EncryptedCodeExecutionResultBlock"]


class EncryptedCodeExecutionResultBlock(BaseModel):
    """Code execution result with encrypted stdout for PFC + web_search results."""

    content: List[CodeExecutionOutputBlock]

    encrypted_stdout: str

    return_code: int

    stderr: str

    type: Literal["encrypted_code_execution_result"]
