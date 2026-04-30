# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Literal, TypeAlias

from ..._models import BaseModel
from .beta_bash_code_execution_result_block import BetaBashCodeExecutionResultBlock
from .beta_bash_code_execution_tool_result_error import BetaBashCodeExecutionToolResultError

__all__ = ["BetaBashCodeExecutionToolResultBlock", "Content"]

Content: TypeAlias = Union[BetaBashCodeExecutionToolResultError, BetaBashCodeExecutionResultBlock]


class BetaBashCodeExecutionToolResultBlock(BaseModel):
    content: Content

    tool_use_id: str

    type: Literal["bash_code_execution_tool_result"]
