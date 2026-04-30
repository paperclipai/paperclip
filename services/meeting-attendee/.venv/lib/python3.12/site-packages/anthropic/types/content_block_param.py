# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union
from typing_extensions import TypeAlias

from .text_block_param import TextBlockParam
from .image_block_param import ImageBlockParam
from .document_block_param import DocumentBlockParam
from .thinking_block_param import ThinkingBlockParam
from .tool_use_block_param import ToolUseBlockParam
from .tool_result_block_param import ToolResultBlockParam
from .search_result_block_param import SearchResultBlockParam
from .server_tool_use_block_param import ServerToolUseBlockParam
from .container_upload_block_param import ContainerUploadBlockParam
from .redacted_thinking_block_param import RedactedThinkingBlockParam
from .web_fetch_tool_result_block_param import WebFetchToolResultBlockParam
from .web_search_tool_result_block_param import WebSearchToolResultBlockParam
from .tool_search_tool_result_block_param import ToolSearchToolResultBlockParam
from .code_execution_tool_result_block_param import CodeExecutionToolResultBlockParam
from .bash_code_execution_tool_result_block_param import BashCodeExecutionToolResultBlockParam
from .text_editor_code_execution_tool_result_block_param import TextEditorCodeExecutionToolResultBlockParam

__all__ = ["ContentBlockParam"]

ContentBlockParam: TypeAlias = Union[
    TextBlockParam,
    ImageBlockParam,
    DocumentBlockParam,
    SearchResultBlockParam,
    ThinkingBlockParam,
    RedactedThinkingBlockParam,
    ToolUseBlockParam,
    ToolResultBlockParam,
    ServerToolUseBlockParam,
    WebSearchToolResultBlockParam,
    WebFetchToolResultBlockParam,
    CodeExecutionToolResultBlockParam,
    BashCodeExecutionToolResultBlockParam,
    TextEditorCodeExecutionToolResultBlockParam,
    ToolSearchToolResultBlockParam,
    ContainerUploadBlockParam,
]
