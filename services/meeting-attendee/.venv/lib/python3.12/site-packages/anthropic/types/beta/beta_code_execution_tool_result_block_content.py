# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import TypeAlias

from .beta_code_execution_result_block import BetaCodeExecutionResultBlock
from .beta_code_execution_tool_result_error import BetaCodeExecutionToolResultError
from .beta_encrypted_code_execution_result_block import BetaEncryptedCodeExecutionResultBlock

__all__ = ["BetaCodeExecutionToolResultBlockContent"]

BetaCodeExecutionToolResultBlockContent: TypeAlias = Union[
    BetaCodeExecutionToolResultError, BetaCodeExecutionResultBlock, BetaEncryptedCodeExecutionResultBlock
]
