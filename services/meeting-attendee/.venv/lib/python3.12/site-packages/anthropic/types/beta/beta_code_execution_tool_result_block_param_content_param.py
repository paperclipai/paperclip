# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union
from typing_extensions import TypeAlias

from .beta_code_execution_result_block_param import BetaCodeExecutionResultBlockParam
from .beta_code_execution_tool_result_error_param import BetaCodeExecutionToolResultErrorParam
from .beta_encrypted_code_execution_result_block_param import BetaEncryptedCodeExecutionResultBlockParam

__all__ = ["BetaCodeExecutionToolResultBlockParamContentParam"]

BetaCodeExecutionToolResultBlockParamContentParam: TypeAlias = Union[
    BetaCodeExecutionToolResultErrorParam, BetaCodeExecutionResultBlockParam, BetaEncryptedCodeExecutionResultBlockParam
]
