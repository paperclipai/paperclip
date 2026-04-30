# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Literal, Annotated, TypeAlias

from .._utils import PropertyInfo
from .._models import BaseModel
from .text_block import TextBlock
from .thinking_block import ThinkingBlock
from .tool_use_block import ToolUseBlock
from .server_tool_use_block import ServerToolUseBlock
from .container_upload_block import ContainerUploadBlock
from .redacted_thinking_block import RedactedThinkingBlock
from .web_fetch_tool_result_block import WebFetchToolResultBlock
from .web_search_tool_result_block import WebSearchToolResultBlock
from .tool_search_tool_result_block import ToolSearchToolResultBlock
from .code_execution_tool_result_block import CodeExecutionToolResultBlock
from .bash_code_execution_tool_result_block import BashCodeExecutionToolResultBlock
from .text_editor_code_execution_tool_result_block import TextEditorCodeExecutionToolResultBlock

__all__ = ["RawContentBlockStartEvent", "ContentBlock"]

ContentBlock: TypeAlias = Annotated[
    Union[
        TextBlock,
        ThinkingBlock,
        RedactedThinkingBlock,
        ToolUseBlock,
        ServerToolUseBlock,
        WebSearchToolResultBlock,
        WebFetchToolResultBlock,
        CodeExecutionToolResultBlock,
        BashCodeExecutionToolResultBlock,
        TextEditorCodeExecutionToolResultBlock,
        ToolSearchToolResultBlock,
        ContainerUploadBlock,
    ],
    PropertyInfo(discriminator="type"),
]


class RawContentBlockStartEvent(BaseModel):
    content_block: ContentBlock
    """Response model for a file uploaded to the container."""

    index: int

    type: Literal["content_block_start"]
