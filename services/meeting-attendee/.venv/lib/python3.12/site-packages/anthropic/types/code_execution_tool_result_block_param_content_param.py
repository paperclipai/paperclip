# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union
from typing_extensions import TypeAlias

from .code_execution_result_block_param import CodeExecutionResultBlockParam
from .code_execution_tool_result_error_param import CodeExecutionToolResultErrorParam
from .encrypted_code_execution_result_block_param import EncryptedCodeExecutionResultBlockParam

__all__ = ["CodeExecutionToolResultBlockParamContentParam"]

CodeExecutionToolResultBlockParamContentParam: TypeAlias = Union[
    CodeExecutionToolResultErrorParam, CodeExecutionResultBlockParam, EncryptedCodeExecutionResultBlockParam
]
