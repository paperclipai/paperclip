# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import TypeAlias

from .code_execution_result_block import CodeExecutionResultBlock
from .code_execution_tool_result_error import CodeExecutionToolResultError
from .encrypted_code_execution_result_block import EncryptedCodeExecutionResultBlock

__all__ = ["CodeExecutionToolResultBlockContent"]

CodeExecutionToolResultBlockContent: TypeAlias = Union[
    CodeExecutionToolResultError, CodeExecutionResultBlock, EncryptedCodeExecutionResultBlock
]
