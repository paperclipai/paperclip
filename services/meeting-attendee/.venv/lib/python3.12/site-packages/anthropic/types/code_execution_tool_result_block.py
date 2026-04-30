# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from .._models import BaseModel
from .code_execution_tool_result_block_content import CodeExecutionToolResultBlockContent

__all__ = ["CodeExecutionToolResultBlock"]


class CodeExecutionToolResultBlock(BaseModel):
    content: CodeExecutionToolResultBlockContent
    """Code execution result with encrypted stdout for PFC + web_search results."""

    tool_use_id: str

    type: Literal["code_execution_tool_result"]
