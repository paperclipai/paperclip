# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Literal, TypeAlias

from .._models import BaseModel
from .bash_code_execution_result_block import BashCodeExecutionResultBlock
from .bash_code_execution_tool_result_error import BashCodeExecutionToolResultError

__all__ = ["BashCodeExecutionToolResultBlock", "Content"]

Content: TypeAlias = Union[BashCodeExecutionToolResultError, BashCodeExecutionResultBlock]


class BashCodeExecutionToolResultBlock(BaseModel):
    content: Content

    tool_use_id: str

    type: Literal["bash_code_execution_tool_result"]
