# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from .._models import BaseModel
from .bash_code_execution_tool_result_error_code import BashCodeExecutionToolResultErrorCode

__all__ = ["BashCodeExecutionToolResultError"]


class BashCodeExecutionToolResultError(BaseModel):
    error_code: BashCodeExecutionToolResultErrorCode

    type: Literal["bash_code_execution_tool_result_error"]
